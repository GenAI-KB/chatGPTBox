import './styles.scss'
import { unmountComponentAtNode } from 'react-dom'
import { render } from 'preact'
import DecisionCard from '../components/DecisionCard'
import { config as siteConfig } from './site-adapters'
import { config as toolsConfig } from './selection-tools'
import { config as menuConfig } from './menu-tools'
import {
  chatgptWebModelKeys,
  getPreferredLanguageKey,
  getUserConfig,
  setAccessToken,
  setUserConfig,
} from '../config/index.mjs'
import {
  createElementAtPosition,
  cropText,
  getClientPosition,
  getPossibleElementByQuerySelector,
} from '../utils'
import FloatingToolbar from '../components/FloatingToolbar'
import Browser from 'webextension-polyfill'
import { getPreferredLanguage } from '../config/language.mjs'
import '../_locales/i18n-react'
import { changeLanguage } from 'i18next'
import { initSession } from '../services/init-session.mjs'
import { getChatGptAccessToken, registerPortListener } from '../services/wrappers.mjs'
import { generateAnswersWithChatgptWebApi } from '../services/apis/chatgpt-web.mjs'
import NotificationForChatGPTWeb from '../components/NotificationForChatGPTWeb'
import { getCoreContentText } from '../utils/get-core-content-text'
/**
 * @param {SiteConfig} siteConfig
 * @param {UserConfig} userConfig
 */
async function mountComponent(siteConfig, userConfig) {
  const retry = 10
  let oldUrl = location.href
  for (let i = 1; i <= retry; i++) {
    if (location.href !== oldUrl) {
      console.log(`SiteAdapters Retry ${i}/${retry}: stop`)
      return
    }
    const e =
      (siteConfig &&
        (getPossibleElementByQuerySelector(siteConfig.sidebarContainerQuery) ||
          getPossibleElementByQuerySelector(siteConfig.appendContainerQuery) ||
          getPossibleElementByQuerySelector(siteConfig.resultsContainerQuery))) ||
      getPossibleElementByQuerySelector([userConfig.prependQuery]) ||
      getPossibleElementByQuerySelector([userConfig.appendQuery])
    if (e) {
      console.log(`SiteAdapters Retry ${i}/${retry}: found`)
      console.log(e)
      break
    } else {
      console.log(`SiteAdapters Retry ${i}/${retry}: not found`)
      if (i === retry) return
      else await new Promise((r) => setTimeout(r, 500))
    }
  }
  document.querySelectorAll('.chatgptbox-container,#chatgptbox-container').forEach((e) => {
    unmountComponentAtNode(e)
    e.remove()
  })

  let question
  if (userConfig.inputQuery) question = await getInput([userConfig.inputQuery])
  if (!question && siteConfig) question = await getInput(siteConfig.inputQuery)

  document.querySelectorAll('.chatgptbox-container,#chatgptbox-container').forEach((e) => {
    unmountComponentAtNode(e)
    e.remove()
  })
  const container = document.createElement('div')
  container.id = 'chatgptbox-container'
  render(
    <DecisionCard
      session={initSession({ modelName: (await getUserConfig()).modelName })}
      question={question}
      siteConfig={siteConfig}
      container={container}
    />,
    container,
  )
}

/**
 * @param {string[]|function} inputQuery
 * @returns {Promise<string>}
 */
async function getInput(inputQuery) {
  let input
  if (typeof inputQuery === 'function') {
    input = await inputQuery()
    const replyPromptBelow = `Reply in ${await getPreferredLanguage()}. Regardless of the language of content I provide below. !!This is very important!!`
    const replyPromptAbove = `Reply in ${await getPreferredLanguage()}. Regardless of the language of content I provide above. !!This is very important!!`
    if (input) return `${replyPromptBelow}\n\n` + input + `\n\n${replyPromptAbove}`
    return input
  }
  const searchInput = getPossibleElementByQuerySelector(inputQuery)
  if (searchInput) {
    if (searchInput.value) input = searchInput.value
    else if (searchInput.textContent) input = searchInput.textContent
    if (input)
      return (
        `Reply in ${await getPreferredLanguage()}.\nThe following is a search input in a search engine, ` +
        `giving useful content or solutions and as much information as you can related to it, ` +
        `use markdown syntax to make your answer more readable, such as code blocks, bold, list:\n` +
        input
      )
  }
}

let toolbarContainer
const deleteToolbar = () => {
  if (toolbarContainer && toolbarContainer.className === 'chatgptbox-toolbar-container')
    toolbarContainer.remove()
}

const createSelectionTools = async (toolbarContainer, selection) => {
  toolbarContainer.className = 'chatgptbox-toolbar-container'
  render(
    <FloatingToolbar
      session={initSession({ modelName: (await getUserConfig()).modelName })}
      selection={selection}
      container={toolbarContainer}
      dockable={true}
    />,
    toolbarContainer,
  )
}

async function prepareForSelectionTools() {
  document.addEventListener('mouseup', (e) => {
    if (toolbarContainer && toolbarContainer.contains(e.target)) return
    const selectionElement =
      window.getSelection()?.rangeCount > 0 &&
      window.getSelection()?.getRangeAt(0).endContainer.parentElement
    if (toolbarContainer && selectionElement && toolbarContainer.contains(selectionElement)) return

    deleteToolbar()
    setTimeout(async () => {
      const selection = window
        .getSelection()
        ?.toString()
        .trim()
        .replace(/^-+|-+$/g, '')
      if (selection) {
        let position

        const config = await getUserConfig()
        if (!config.selectionToolsNextToInputBox) position = { x: e.pageX + 20, y: e.pageY + 20 }
        else {
          const inputElement = selectionElement.querySelector('input, textarea')
          if (inputElement) {
            position = getClientPosition(inputElement)
            position = {
              x: position.x + window.scrollX + inputElement.offsetWidth + 50,
              y: e.pageY + 30,
            }
          } else {
            position = { x: e.pageX + 20, y: e.pageY + 20 }
          }
        }
        toolbarContainer = createElementAtPosition(position.x, position.y)
        await createSelectionTools(toolbarContainer, selection)
      }
    })
  })
  document.addEventListener('mousedown', (e) => {
    if (toolbarContainer && toolbarContainer.contains(e.target)) return

    document.querySelectorAll('.chatgptbox-toolbar-container').forEach((e) => e.remove())
  })
  document.addEventListener('keydown', (e) => {
    if (
      toolbarContainer &&
      !toolbarContainer.contains(e.target) &&
      (e.target.nodeName === 'INPUT' || e.target.nodeName === 'TEXTAREA')
    ) {
      setTimeout(() => {
        if (!window.getSelection()?.toString().trim()) deleteToolbar()
      })
    }
  })
}

async function prepareForSelectionToolsTouch() {
  document.addEventListener('touchend', (e) => {
    if (toolbarContainer && toolbarContainer.contains(e.target)) return
    if (
      toolbarContainer &&
      window.getSelection()?.rangeCount > 0 &&
      toolbarContainer.contains(window.getSelection()?.getRangeAt(0).endContainer.parentElement)
    )
      return

    deleteToolbar()
    setTimeout(() => {
      const selection = window
        .getSelection()
        ?.toString()
        .trim()
        .replace(/^-+|-+$/g, '')
      if (selection) {
        toolbarContainer = createElementAtPosition(
          e.changedTouches[0].pageX + 20,
          e.changedTouches[0].pageY + 20,
        )
        createSelectionTools(toolbarContainer, selection)
      }
    })
  })
  document.addEventListener('touchstart', (e) => {
    if (toolbarContainer && toolbarContainer.contains(e.target)) return

    document.querySelectorAll('.chatgptbox-toolbar-container').forEach((e) => e.remove())
  })
}

let menuX, menuY

async function prepareForRightClickMenu() {
  document.addEventListener('contextmenu', (e) => {
    menuX = e.clientX
    menuY = e.clientY
  })

  Browser.runtime.onMessage.addListener(async (message) => {
    if (message.type === 'CREATE_CHAT') {
      const data = message.data
      let prompt = ''
      if (data.itemId in toolsConfig) {
        prompt = await toolsConfig[data.itemId].genPrompt(data.selectionText)
      } else if (data.itemId in menuConfig) {
        const menuItem = menuConfig[data.itemId]
        if (!menuItem.genPrompt) return
        else prompt = await menuItem.genPrompt()
        if (prompt) prompt = await cropText(`Reply in ${await getPreferredLanguage()}.\n` + prompt)
      }

      const position = data.useMenuPosition
        ? { x: menuX, y: menuY }
        : { x: window.innerWidth / 2 - 300, y: window.innerHeight / 2 - 200 }
      const container = createElementAtPosition(position.x, position.y)
      container.className = 'chatgptbox-toolbar-container-not-queryable'
      render(
        <FloatingToolbar
          session={initSession({ modelName: (await getUserConfig()).modelName })}
          selection={data.selectionText}
          container={container}
          triggered={true}
          closeable={true}
          prompt={prompt}
        />,
        container,
      )
    }
  })
}

async function prepareForStaticCard() {
  const userConfig = await getUserConfig()
  let siteRegex
  if (userConfig.useSiteRegexOnly) siteRegex = userConfig.siteRegex
  else
    siteRegex = new RegExp(
      (userConfig.siteRegex && userConfig.siteRegex + '|') + Object.keys(siteConfig).join('|'),
    )

  const matches = location.hostname.match(siteRegex)
  if (matches) {
    const siteName = matches[0]

    if (
      userConfig.siteAdapters.includes(siteName) &&
      !userConfig.activeSiteAdapters.includes(siteName)
    )
      return

    let initSuccess = true
    if (siteName in siteConfig) {
      const siteAction = siteConfig[siteName].action
      if (siteAction && siteAction.init) {
        initSuccess = await siteAction.init(location.hostname, userConfig, getInput, mountComponent)
      }
    }

    if (initSuccess) mountComponent(siteConfig[siteName], userConfig)
  }
}

async function overwriteAccessToken() {
  if (location.hostname !== 'chat.openai.com') {
    if (location.hostname === 'kimi.moonshot.cn') {
      setUserConfig({
        kimiMoonShotRefreshToken: window.localStorage.refresh_token,
      })
    }
    return
  }

  let data
  if (location.pathname === '/api/auth/session') {
    const response = document.querySelector('pre').textContent
    try {
      data = JSON.parse(response)
    } catch (error) {
      console.error('json error', error)
    }
  } else {
    const resp = await fetch('https://chat.openai.com/api/auth/session')
    data = await resp.json().catch(() => ({}))
  }
  if (data && data.accessToken) {
    await setAccessToken(data.accessToken)
    console.log(data.accessToken)
  }
}

async function prepareForForegroundRequests() {
  if (location.hostname !== 'chat.openai.com' || location.pathname === '/auth/login') return

  const userConfig = await getUserConfig()

  if (!chatgptWebModelKeys.some((model) => userConfig.activeApiModes.includes(model))) return

  if (chatgptWebModelKeys.includes(userConfig.modelName)) {
    const div = document.createElement('div')
    document.body.append(div)
    render(<NotificationForChatGPTWeb container={div} />, div)
  }

  if (location.pathname === '/') {
    const input = document.querySelector('#prompt-textarea')
    if (input) {
      input.textContent = ' '
      input.dispatchEvent(new Event('input', { bubbles: true }))
      setTimeout(() => {
        input.textContent = ''
        input.dispatchEvent(new Event('input', { bubbles: true }))
      }, 300)
    }
  }

  await Browser.runtime.sendMessage({
    type: 'SET_CHATGPT_TAB',
    data: {},
  })

  registerPortListener(async (session, port) => {
    if (chatgptWebModelKeys.includes(session.modelName)) {
      const accessToken = await getChatGptAccessToken()
      await generateAnswersWithChatgptWebApi(port, session.question, session, accessToken)
    }
  })
}

async function run() {
  await getPreferredLanguageKey().then((lang) => {
    changeLanguage(lang)
  })
  Browser.runtime.onMessage.addListener(async (message) => {
    if (message.type === 'CHANGE_LANG') {
      const data = message.data
      changeLanguage(data.lang)
    }
  })
  window.addEventListener('load', () => {
    if (document.URL.startsWith('https://restofworld.org')) {
      // 发送消息给插件的后台页面
      Browser.runtime.sendMessage({
        prompt: {
          type: 'summary',
          question: `以下是一个网页的文本内容，请用中文分析核心内容并总结:\n${getCoreContentText()}`,
        },
      })
    }
    if (document.URL.startsWith('https://aihub0449696156.z1.web.core.windows.net')) {
      document.addEventListener('focusout', (e) => {
        let sender = e.target
        let p = ''
        let type = ''
        if (sender.id == 'desc') {
          if (sender.value.length > 5) {
            type = 'desc'
            p = `请根据给定的信息分析[${sender.value}]这一故障现象可能的原因，如有多种可能，请用列表形式返回,仅提供故障原因即可，不用提供解决方案。}`
          }
        }
        if (sender.id == 'anay') {
          if (sender.value.length > 5) {
            type = 'anay'
            p = `请根据给定的信息给出[${sender.value}]这一故障的解决方案，如有多种可能，请用列表形式返回。}`
          }
        }
        if (p == '') return
        p += `参考的信息如下:
         | Problem | Possible causes | Action |
  | - | - | - |
  | The dishes are not clean. | The spray arms do not rotate. | Check that the dishes are not blocking the spray arms. |
  || Spray arm holes or bearings blocked. | Clean the spray arms. See the chapter Care and cleaning. |
  || Unsuitable dishwashing program. | Select a program with a high temperature to dissolve grease on very dirty dishes, such as Intensive. |
  || Incorrect detergent dosage. | Dose according to water hardness. Far too much or far too little detergent results in poorer dishwashing results. |
  || Old detergent. Detergent is a perishable product. | Avoid large packages. |
  || Dishes loaded incorrectly. | Do not cover porcelain with large bowls or the like. Avoid placing very tall glasses in the corners of the baskets. See the chapter Loading the dishwasher. |
  ||| Glasses and cups have toppled Place dishes to sit steady. | over during the program. 
  || The filters are clogged. | Clean the coarse and fine filters. |
  || The filters are not fitted correctly. | Check that the filters are fitted correctly. See the chapter Care and cleaning. |
  || Drainage pump stop missing. | Check that the yellow drainage pump stop (on the right in the bottom drain) is in place. See the chapter Care and cleaning. |
  | Spots on stainless steel or silver. | Some foodstuffs, such as mustard, mayonnaise, lemon, vinegar, salt and dressings, can| cause spots on stainless steel if the Rinse and hold program. left for too long.  Rinse off these types of foodstuffs if not starting the dishwasher immediately. Use |
  || All stainless steel can cause spots on silver if they come into contact during dishwashing. Aluminium can also cause spots on dishes. | In order to avoid marks and tarnishing, separate dishes made from different metals, such as silver, stainless steel and aluminium. |
  
  
  | Problem | Possible causes | Action |
  | - | - | - |
  | Water remains in the dishwasher. | The filters are clogged. | Clean the coarse and fine filters. |
  || The filters are not fitted correctly. | Check that the filters are fitted correctly. See the chapter Care and cleaning. |
  || Debris in the drainage pump. | Clean the drainage pump. See the chapter Care and cleaning. |
  || Drainage pump stop missing. | Check that the yellow drainage pump stop (on the right in the bottom drain) is in place. See the chapter Care and cleaning. |
  || Kink in drainage hose. | Check that the hose is free from kinks and sharp bends. |
  || Blocked drainage hose. | Disconnect the drainage hose where it connects to the sink unit's water trap. Check that no debris has fastened and that the connection has an inner diameter of at least 14 mm. |
  | Bad odour in dishwasher. | Dirt around the seals and in corners. | Clean with washing-up brush and low foaming cleaner. |
  || Low temperature programs have been selected for a prolonged period. | Run a program with a high temperature once or twice a month. Or run a self-cleaning program. See Self-cleaning in the chapter Using the dishwasher. |
  | Grease deposits in the dishwasher. | Low temperature programs have been selected for a prolonged period. | Select a program with a high temperature to dissolve grease on very dirty dishes, such as Intensive. Or run a self-cleaning program once or twice a month. See Self-cleaning in the chapter Using the dishwasher. |
  
         `
        // 发送消息给插件的后台页面
        Browser.runtime.sendMessage({ prompt: { type: type, question: p } })
      })
    }
  })

  await overwriteAccessToken()
  await prepareForForegroundRequests()

  prepareForSelectionTools()
  prepareForSelectionToolsTouch()
  prepareForStaticCard()
  prepareForRightClickMenu()
}

run()
