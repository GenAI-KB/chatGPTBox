import { memo, useEffect, useMemo, useRef, useState } from 'react'
import PropTypes from 'prop-types'
import Browser from 'webextension-polyfill'
import InputBox from '../InputBox'
import ConversationItem from '../ConversationItem'
import { createElementAtPosition, isFirefox, isMobile, isSafari } from '../../utils'
import { LinkExternalIcon, MoveToBottomIcon } from '@primer/octicons-react'
import { Pin, WindowDesktop, XLg } from 'react-bootstrap-icons'

import { render } from 'preact'
import FloatingToolbar from '../FloatingToolbar'
import { useClampWindowSize } from '../../hooks/use-clamp-window-size'
import { bingWebModelKeys, getUserConfig } from '../../config/index.mjs'
import { useTranslation } from 'react-i18next'
import DeleteButton from '../DeleteButton'
import { useConfig } from '../../hooks/use-config.mjs'

import { initSession } from '../../services/init-session.mjs'
import { findLastIndex } from 'lodash-es'
import { generateAnswersWithBingWebApi } from '../../services/apis/bing-web.mjs'
import { handlePortError } from '../../services/wrappers.mjs'
import { getCoreContentText } from '../../utils/get-core-content-text'

const logo = Browser.runtime.getURL('logo.png')

class ConversationItemData extends Object {
  /**
   * @param {'question'|'answer'|'error'} type
   * @param {string} content
   * @param {bool} done
   */
  constructor(type, content, done = false) {
    super()
    this.type = type
    this.content = content
    this.done = done
  }
}

function ConversationCard(props) {
  const { t } = useTranslation()
  const [isReady, setIsReady] = useState(!props.question)
  const [port, setPort] = useState(() => Browser.runtime.connect())
  const [session, setSession] = useState(props.session)
  const windowSize = useClampWindowSize([750, 1500], [250, 1100])
  const bodyRef = useRef(null)
  const [completeDraggable, setCompleteDraggable] = useState(false)
  // `.some` for multi mode models. e.g. bingFree4-balanced
  const useForegroundFetch = bingWebModelKeys.some((n) => session.modelName.includes(n))

  /**
   * @type {[ConversationItemData[], (conversationItemData: ConversationItemData[]) => void]}
   */
  const [conversationItemData, setConversationItemData] = useState(
    (() => {
      if (session.conversationRecords.length === 0)
        if (props.question)
          return [
            new ConversationItemData(
              'answer',
              `<p class="gpt-loading">${t(`Waiting for response...`)}</p>`,
            ),
          ]
        else return []
      else {
        const ret = []
        for (const record of session.conversationRecords) {
          ret.push(new ConversationItemData('question', record.question, true))
          ret.push(new ConversationItemData('answer', record.answer, true))
        }
        return ret
      }
    })(),
  )
  const config = useConfig()

  useEffect(() => {
    setCompleteDraggable(!isSafari() && !isFirefox() && !isMobile())
    Browser.runtime.onMessage.addListener((msg) => {
      if (msg.prompt == null) return
      let question = msg.prompt.question
      const newQuestion = new ConversationItemData('question', question)
      let ans = '正在为您生成这篇文章的摘要...'
      if (msg.prompt.type == 'desc') ans = '正在根据故障现象检索可能的故障题原因'
      if (msg.prompt.type == 'anay') ans = '正在根据故障原因检索可能的解决方案'
      const newAnswer = new ConversationItemData('answer', `<p class="gpt-loading">${t(ans)}</p>`)
      if (msg.showQuestion) {
        setConversationItemData([...conversationItemData, newQuestion, newAnswer])
      } else {
        setConversationItemData([...conversationItemData, newAnswer])
      }

      setIsReady(false)
      const newSession = initSession({
        ...session,
        question: question,
        isRetry: false,
      })

      setSession(newSession)
      try {
        postMessage({ session: newSession })
      } catch (e) {
        updateAnswer(e, false, 'error')
      }
    })
  }, [])

  useEffect(() => {
    if (props.onUpdate) props.onUpdate(port, session, conversationItemData)
  }, [session, conversationItemData])

  useEffect(() => {
    const { offsetHeight, scrollHeight, scrollTop } = bodyRef.current
    if (
      config.lockWhenAnswer &&
      scrollHeight <= scrollTop + offsetHeight + config.answerScrollMargin
    ) {
      bodyRef.current.scrollTo({
        top: scrollHeight,
        behavior: 'instant',
      })
    }
  }, [conversationItemData])

  useEffect(async () => {
    // when the page is responsive, session may accumulate redundant data and needs to be cleared after remounting and before making a new request
    if (props.question) {
      const newSession = initSession({ ...session, question: props.question })
      setSession(newSession)
      await postMessage({ session: newSession })
    }
  }, [props.question]) // usually only triggered once

  /**
   * @param {string} value
   * @param {boolean} appended
   * @param {'question'|'answer'|'error'} newType
   * @param {boolean} done
   */
  const updateAnswer = (value, appended, newType, done = false) => {
    setConversationItemData((old) => {
      const copy = [...old]
      const index = findLastIndex(copy, (v) => v.type === 'answer' || v.type === 'error')
      if (index === -1) return copy
      copy[index] = new ConversationItemData(
        newType,
        appended ? copy[index].content + value : value,
      )
      copy[index].done = done
      return copy
    })
  }

  const portMessageListener = (msg) => {
    if (msg.answer) {
      updateAnswer(msg.answer, false, 'answer')
    }
    if (msg.session) {
      if (msg.done) msg.session = { ...msg.session, isRetry: false }
      setSession(msg.session)
    }
    if (msg.done) {
      updateAnswer('', true, 'answer', true)
      setIsReady(true)
    }
    if (msg.error) {
      switch (msg.error) {
        case 'UNAUTHORIZED':
          updateAnswer(
            `${t('UNAUTHORIZED')}<br>${t('Please login at https://chat.openai.com first')}${
              isSafari() ? `<br>${t('Then open https://chat.openai.com/api/auth/session')}` : ''
            }<br>${t('And refresh this page or type you question again')}` +
              `<br><br>${t(
                'Consider creating an api key at https://platform.openai.com/account/api-keys',
              )}`,
            false,
            'error',
          )
          break
        case 'CLOUDFLARE':
          updateAnswer(
            `${t('OpenAI Security Check Required')}<br>${
              isSafari()
                ? t('Please open https://chat.openai.com/api/auth/session')
                : t('Please open https://chat.openai.com')
            }<br>${t('And refresh this page or type you question again')}` +
              `<br><br>${t(
                'Consider creating an api key at https://platform.openai.com/account/api-keys',
              )}`,
            false,
            'error',
          )
          break
        default: {
          let formattedError = msg.error
          if (typeof msg.error === 'string' && msg.error.trimStart().startsWith('{'))
            try {
              formattedError = JSON.stringify(JSON.parse(msg.error), null, 2)
            } catch (e) {
              /* empty */
            }

          let lastItem
          if (conversationItemData.length > 0)
            lastItem = conversationItemData[conversationItemData.length - 1]
          if (lastItem && (lastItem.content.includes('gpt-loading') || lastItem.type === 'error'))
            updateAnswer(t(formattedError), false, 'error')
          else
            setConversationItemData([
              ...conversationItemData,
              new ConversationItemData('error', t(formattedError)),
            ])
          break
        }
      }
      setIsReady(true)
    }
    if (msg.hello) {
      const newAnswer = new ConversationItemData('answer', `${msg.hello}`)
      setConversationItemData([...conversationItemData, newAnswer])
      const newSession = { ...session, answer: msg.hello, isRetry: false }
      setSession(newSession)
      setIsReady(true)
    }
    if (msg.question) {
      const newQuestion = new ConversationItemData('question', msg.question)
      const newAnswer = new ConversationItemData(
        'answer',
        `<p class="gpt-loading">${t('Waiting for response...')}</p>`,
      )
      if (msg.showQuestion) {
        setConversationItemData([...conversationItemData, newQuestion, newAnswer])
      } else {
        setConversationItemData([...conversationItemData, newAnswer])
      }

      setIsReady(false)

      const newSession = { ...session, question: msg.question, isRetry: false }
      setSession(newSession)
      try {
        postMessage({ session: newSession })
      } catch (e) {
        updateAnswer(e, false, 'error')
      }
    }
    if (msg.command) {
      let question = `The following is the text content of a web page, analyze the core content and summarize:\n${getCoreContentText()}`
      const newQuestion = new ConversationItemData('question', question)
      const newAnswer = new ConversationItemData(
        'answer',
        `<p class="gpt-loading">${t('Waiting for response...')}</p>`,
      )
      if (msg.showQuestion) {
        setConversationItemData([...conversationItemData, newQuestion, newAnswer])
      } else {
        setConversationItemData([...conversationItemData, newAnswer])
      }

      setIsReady(false)

      const newSession = { ...session, question: question, isRetry: false }
      setSession(newSession)
      try {
        postMessage({ session: newSession })
      } catch (e) {
        updateAnswer(e, false, 'error')
      }
    }
  }

  const foregroundMessageListeners = useRef([])

  /**
   * @param {Session|undefined} session
   * @param {boolean|undefined} stop
   */
  const postMessage = async ({ session, stop }) => {
    if (useForegroundFetch) {
      foregroundMessageListeners.current.forEach((listener) => listener({ session, stop }))
      if (session) {
        const fakePort = {
          postMessage: (msg) => {
            portMessageListener(msg)
          },
          onMessage: {
            addListener: (listener) => {
              foregroundMessageListeners.current.push(listener)
            },
            removeListener: (listener) => {
              foregroundMessageListeners.current.splice(
                foregroundMessageListeners.current.indexOf(listener),
                1,
              )
            },
          },
          onDisconnect: {
            addListener: () => {},
            removeListener: () => {},
          },
        }
        try {
          const bingToken = (await getUserConfig()).bingAccessToken
          if (session.modelName.includes('bingFreeSydney'))
            await generateAnswersWithBingWebApi(
              fakePort,
              session.question,
              session,
              bingToken,
              true,
            )
          else await generateAnswersWithBingWebApi(fakePort, session.question, session, bingToken)
        } catch (err) {
          handlePortError(session, fakePort, err)
        }
      }
    } else {
      try {
        port.postMessage({ session, stop })
      } catch (e) {
        setPort(Browser.runtime.connect())
        setIsReady(true)
        port.postMessage({ session, stop })
      }
    }
  }

  useEffect(() => {
    const portListener = () => {
      setPort(Browser.runtime.connect())
      setIsReady(true)
    }

    const closeChatsListener = (message) => {
      if (message.type === 'CLOSE_CHATS') {
        port.disconnect()
        if (props.onClose) props.onClose()
      }
    }

    if (props.closeable) Browser.runtime.onMessage.addListener(closeChatsListener)
    port.onDisconnect.addListener(portListener)
    return () => {
      if (props.closeable) Browser.runtime.onMessage.removeListener(closeChatsListener)
      port.onDisconnect.removeListener(portListener)
    }
  }, [port])
  useEffect(() => {
    if (useForegroundFetch) {
      return () => {}
    } else {
      port.onMessage.addListener(portMessageListener)
      return () => {
        port.onMessage.removeListener(portMessageListener)
      }
    }
  }, [conversationItemData])

  const getRetryFn = (session) => async () => {
    updateAnswer(`<p class="gpt-loading">${t('Waiting for response...')}</p>`, false, 'answer')
    setIsReady(false)

    if (session.conversationRecords.length > 0) {
      const lastRecord = session.conversationRecords[session.conversationRecords.length - 1]
      if (
        conversationItemData[conversationItemData.length - 1].done &&
        conversationItemData.length > 1 &&
        lastRecord.question === conversationItemData[conversationItemData.length - 2].content
      ) {
        session.conversationRecords.pop()
      }
    }
    const newSession = { ...session, isRetry: true }
    setSession(newSession)
    try {
      await postMessage({ stop: true })
      await postMessage({ session: newSession })
    } catch (e) {
      updateAnswer(e, false, 'error')
    }
  }

  const retryFn = useMemo(() => getRetryFn(session), [session])

  return (
    <div className="gpt-inner">
      <div
        className={
          props.draggable ? `gpt-header${completeDraggable ? ' draggable' : ''}` : 'gpt-header'
        }
        style="user-select:none;"
      >
        <span
          className="gpt-util-group"
          style={{
            padding: '15px 0 15px 15px',
            ...(props.notClampSize ? {} : { flexGrow: isSafari() ? 0 : 1 }),
            ...(isSafari() ? { maxWidth: '200px' } : {}),
          }}
        >
          {props.closeable ? (
            <XLg
              className="gpt-util-icon"
              title={t('Close the Window')}
              size={16}
              onClick={() => {
                port.disconnect()
                if (props.onClose) props.onClose()
              }}
            />
          ) : props.dockable ? (
            <Pin
              className="gpt-util-icon"
              title={t('Pin the Window')}
              size={16}
              onClick={() => {
                if (props.onDock) props.onDock()
              }}
            />
          ) : (
            <img src={logo} style="user-select:none;width:20px;height:20px;" />
          )}
        </span>
        {props.draggable && !completeDraggable && (
          <div className="draggable" style={{ flexGrow: 2, cursor: 'move', height: '55px' }} />
        )}
        <span
          className="gpt-util-group"
          style={{
            padding: '15px 15px 15px 0',
            justifyContent: 'flex-end',
            flexGrow: props.draggable && !completeDraggable ? 0 : 1,
          }}
        >
          {!config.disableWebModeHistory && session && session.conversationId && (
            <a
              title={t('Continue on official website')}
              href={'https://chat.openai.com/chat/' + session.conversationId}
              target="_blank"
              rel="nofollow noopener noreferrer"
              className="gpt-util-icon"
              style="color: inherit;"
            >
              <LinkExternalIcon size={16} />
            </a>
          )}
          <WindowDesktop
            className="gpt-util-icon"
            title={t('Float the Window')}
            size={16}
            onClick={() => {
              const position = { x: window.innerWidth / 2 - 300, y: window.innerHeight / 2 - 200 }
              const toolbarContainer = createElementAtPosition(position.x, position.y)
              toolbarContainer.className = 'chatgptbox-toolbar-container-not-queryable'
              render(
                <FloatingToolbar
                  session={session}
                  selection=""
                  container={toolbarContainer}
                  closeable={true}
                  triggered={true}
                />,
                toolbarContainer,
              )
            }}
          />
          <DeleteButton
            size={16}
            text={t('Clear Conversation')}
            onConfirm={async () => {
              await postMessage({ stop: true })
              Browser.runtime.sendMessage({
                type: 'DELETE_CONVERSATION',
                data: {
                  conversationId: session.conversationId,
                },
              })
              setConversationItemData([])
              const newSession = initSession({
                ...session,
                question: null,
                conversationRecords: [],
              })
              newSession.sessionId = session.sessionId
              setSession(newSession)
            }}
          />
          {conversationItemData.length > 0 && (
            <span
              title={t('Jump to bottom')}
              className="gpt-util-icon"
              onClick={() => {
                bodyRef.current.scrollTo({
                  top: bodyRef.current.scrollHeight,
                  behavior: 'smooth',
                })
              }}
            >
              <MoveToBottomIcon size={16} />
            </span>
          )}
        </span>
      </div>
      <hr />
      <div
        ref={bodyRef}
        className="markdown-body"
        style={
          props.notClampSize
            ? { flexGrow: 1 }
            : { maxHeight: windowSize[1] * 0.55 + 'px', resize: 'vertical' }
        }
      >
        {conversationItemData.map((data, idx) => (
          <ConversationItem
            content={data.content}
            key={idx}
            type={data.type}
            descName={data.type === 'answer' && session.aiName}
            modelName={data.type === 'answer' && session.modelName}
            onRetry={idx === conversationItemData.length - 1 ? retryFn : null}
          />
        ))}
      </div>
      <InputBox
        enabled={isReady}
        postMessage={postMessage}
        reverseResizeDir={props.pageMode}
        onSubmit={async (question) => {
          const newQuestion = new ConversationItemData('question', question)
          const newAnswer = new ConversationItemData(
            'answer',
            `<p class="gpt-loading">${t('Waiting for response...')}</p>`,
          )
          setConversationItemData([...conversationItemData, newQuestion, newAnswer])
          setIsReady(false)

          const newSession = { ...session, question, isRetry: false }
          setSession(newSession)
          try {
            await postMessage({ session: newSession })
          } catch (e) {
            updateAnswer(e, false, 'error')
          }
          bodyRef.current.scrollTo({
            top: bodyRef.current.scrollHeight,
            behavior: 'instant',
          })
        }}
      />
    </div>
  )
}

ConversationCard.propTypes = {
  session: PropTypes.object.isRequired,
  question: PropTypes.string,
  onUpdate: PropTypes.func,
  draggable: PropTypes.bool,
  closeable: PropTypes.bool,
  onClose: PropTypes.func,
  dockable: PropTypes.bool,
  onDock: PropTypes.func,
  notClampSize: PropTypes.bool,
  pageMode: PropTypes.bool,
}

export default memo(ConversationCard)
