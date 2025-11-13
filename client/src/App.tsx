import React, { useEffect, useMemo, useRef, useState } from 'react'
import { io, Socket } from 'socket.io-client'

type RemoteStream = { id: string; stream: MediaStream }
type ChatMessage = { userName: string; message: string; timestamp: number }

const SERVER_URL = import.meta.env.VITE_SERVER_URL || 'http://localhost:3001'

export default function App() {
  const [joined, setJoined] = useState(false)
  const [roomId, setRoomId] = useState('')
  const [userName, setUserName] = useState('')
  const [chatInput, setChatInput] = useState('')
  const [chat, setChat] = useState<ChatMessage[]>([])
  const [audioEnabled, setAudioEnabled] = useState(true)
  const [videoEnabled, setVideoEnabled] = useState(true)
  const [screenSharing, setScreenSharing] = useState(false)
  const [inviteCopied, setInviteCopied] = useState(false)

  const socketRef = useRef<Socket | null>(null)
  const localVideoRef = useRef<HTMLVideoElement | null>(null)
  const localStreamRef = useRef<MediaStream | null>(null)
  const screenStreamRef = useRef<MediaStream | null>(null)

  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map())
  const [remoteStreams, setRemoteStreams] = useState<RemoteStream[]>([])

  const iceServers = useMemo(() => ({
    iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }]
  }), [])

  useEffect(() => {
    const socket = io(SERVER_URL, { transports: ['websocket'] })
    socketRef.current = socket

    socket.on('chat-message', (msg: ChatMessage) => {
      setChat(prev => [...prev, msg])
    })

    socket.on('user-joined', ({ userId, userName: name }: { userId: string; userName: string }) => {
      // Existing participants set up a connection; new user will initiate offers to avoid glare
      createPeerConnection(userId)
      systemMessage(`${name} joined`)
    })

    socket.on('existing-users', ({ users }: { users: string[] }) => {
      users.forEach(userId => {
        createPeerConnection(userId)
        createOffer(userId)
      })
    })

    socket.on('offer', async ({ from, sdp }: { from: string; sdp: RTCSessionDescriptionInit }) => {
      let pc = peersRef.current.get(from)
      if (!pc) {
        pc = createPeerConnection(from)
      }
      await pc.setRemoteDescription(new RTCSessionDescription(sdp))
      await addLocalTracks(pc)
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      socket.emit('answer', { to: from, sdp: answer })
    })

    socket.on('answer', async ({ from, sdp }: { from: string; sdp: RTCSessionDescriptionInit }) => {
      const pc = peersRef.current.get(from)
      if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(sdp))
      }
    })

    socket.on('ice-candidate', async ({ from, candidate }: { from: string; candidate: RTCIceCandidateInit }) => {
      const pc = peersRef.current.get(from)
      if (pc && candidate) {
        try { await pc.addIceCandidate(new RTCIceCandidate(candidate)) } catch {}
      }
    })

    socket.on('user-left', ({ userId, userName: name }: { userId: string; userName: string }) => {
      const pc = peersRef.current.get(userId)
      if (pc) {
        pc.close()
        peersRef.current.delete(userId)
        setRemoteStreams(prev => prev.filter(rs => rs.id !== userId))
      }
      systemMessage(`${name} left`)
    })

    return () => {
      socket.disconnect()
    }
  }, [])

  // Read invite parameters from URL and auto-fill (optional auto-join if name provided)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const rid = params.get('room')
    const nm = params.get('name')
    if (rid) setRoomId(rid)
    if (nm) setUserName(nm || '')
    if (rid && nm && !joined && !localStreamRef.current) {
      setTimeout(() => { joinRoom() }, 0)
    }
  }, [joined])

  const generateMeetingId = (): string => {
    const digits = Array.from({ length: 9 }, () => Math.floor(Math.random() * 10)).join('')
    return `${digits.slice(0,3)}-${digits.slice(3,6)}-${digits.slice(6,9)}`
  }

  const systemMessage = (text: string) => {
    setChat(prev => [...prev, { userName: 'system', message: text, timestamp: Date.now() }])
  }

  // Robust camera acquisition with fallbacks and reliable preview attachment
  const getLocalMedia = async (): Promise<MediaStream> => {
    const attempts: MediaStreamConstraints[] = [
      { video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: true },
      { video: true, audio: true },
      { video: { facingMode: 'user' }, audio: true },
    ]
    for (const c of attempts) {
      try {
        const s = await navigator.mediaDevices.getUserMedia(c)
        return s
      } catch (err: any) {
        if (err && err.name === 'NotAllowedError') {
          throw err
        }
        // Continue to next constraints
      }
    }
    return await navigator.mediaDevices.getUserMedia({ video: true, audio: true })
  }

  const attachLocalVideo = async () => {
    const el = localVideoRef.current
    const stream = localStreamRef.current
    if (!el || !stream) return
    el.srcObject = stream
    el.muted = true
    try {
      await el.play()
    } catch {
      el.onloadedmetadata = () => { el.play().catch(() => {}) }
    }
  }

  const createPeerConnection = (peerId: string) => {
    const pc = new RTCPeerConnection(iceServers)
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socketRef.current?.emit('ice-candidate', { to: peerId, candidate: event.candidate })
      }
    }
    pc.ontrack = (event) => {
      const [stream] = event.streams
      setRemoteStreams(prev => {
        const exists = prev.find(rs => rs.id === peerId)
        if (exists) return prev.map(rs => rs.id === peerId ? { id: peerId, stream } : rs)
        return [...prev, { id: peerId, stream }]
      })
    }
    peersRef.current.set(peerId, pc)
    return pc
  }

  const addLocalTracks = async (pc: RTCPeerConnection) => {
    const audioTracks = localStreamRef.current ? localStreamRef.current.getAudioTracks() : []
    const videoTrack = screenStreamRef.current?.getVideoTracks()[0] || localStreamRef.current?.getVideoTracks()[0] || null
    audioTracks.forEach(t => pc.addTrack(t, localStreamRef.current!))
    if (videoTrack) {
      const ms = screenStreamRef.current || localStreamRef.current!
      pc.addTrack(videoTrack, ms)
    }
  }

  const createOffer = async (peerId: string) => {
    const pc = peersRef.current.get(peerId)
    if (!pc) return
    await addLocalTracks(pc)
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    socketRef.current?.emit('offer', { to: peerId, sdp: offer })
  }

  const joinRoom = async () => {
    const rid = roomId.trim() || generateMeetingId()
    if (!userName.trim()) {
      systemMessage('Enter your name to join the meeting.')
      return
    }
    setRoomId(rid)

    try {
      const stream = await getLocalMedia()
      localStreamRef.current = stream
      await attachLocalVideo()
    } catch (e) {
      systemMessage('Could not access camera/mic. Please allow permissions.')
      return
    }

    setJoined(true)
    socketRef.current?.emit('join-room', { roomId: rid, userName })
  }

  const leaveRoom = () => {
    peersRef.current.forEach(pc => pc.close())
    peersRef.current.clear()
    setRemoteStreams([])
    setJoined(false)
    localStreamRef.current?.getTracks().forEach(t => t.stop())
    localStreamRef.current = null
    socketRef.current?.emit('leave-room', { roomId })
  }

  const toggleAudio = () => {
    const enabled = !audioEnabled
    setAudioEnabled(enabled)
    localStreamRef.current?.getAudioTracks().forEach(t => (t.enabled = enabled))
  }

  const toggleVideo = () => {
    const enabled = !videoEnabled
    // Toggle local camera track
    localStreamRef.current?.getVideoTracks().forEach(t => (t.enabled = enabled))
    // Ensure current sending track(s) reflect the enabled state (camera or screen)
    const senders = Array.from(peersRef.current.values()).flatMap(pc => pc.getSenders())
    senders.forEach(s => {
      if (s.track && s.track.kind === 'video') {
        s.track.enabled = enabled
      }
    })
    // Reflect in local preview for immediate feedback
    if (localVideoRef.current) {
      if (enabled) {
        localVideoRef.current.play().catch(() => { })
      } else {
        try { localVideoRef.current.pause() } catch {}
      }
    }
    setVideoEnabled(enabled)
  }

  const toggleScreenShare = async () => {
    if (!screenSharing) {
      try {
        const display = await navigator.mediaDevices.getDisplayMedia({ video: true })
        const screenTrack = display.getVideoTracks()[0]
        screenStreamRef.current = display
        const senders = Array.from(peersRef.current.values()).flatMap(pc => pc.getSenders())
        const videoSenders = senders.filter(s => s.track && s.track.kind === 'video')
        await Promise.all(videoSenders.map(s => s.replaceTrack(screenTrack)))
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = display
          localVideoRef.current.play().catch(() => {})
        }
        setScreenSharing(true)
        screenTrack.onended = () => { stopScreenShare() }
      } catch {}
    } else {
      stopScreenShare()
    }
  }

  const stopScreenShare = async () => {
    const camTrack = localStreamRef.current?.getVideoTracks()[0]
    if (!camTrack) return
    const senders = Array.from(peersRef.current.values()).flatMap(pc => pc.getSenders())
    const videoSenders = senders.filter(s => s.track && s.track.kind === 'video')
    await Promise.all(videoSenders.map(s => s.replaceTrack(camTrack)))
    if (localVideoRef.current && localStreamRef.current) {
      localVideoRef.current.srcObject = localStreamRef.current
      localVideoRef.current.play().catch(() => {})
    }
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach(t => t.stop())
      screenStreamRef.current = null
    }
    setScreenSharing(false)
  }

  const sendChat = () => {
    if (!chatInput.trim()) return
    socketRef.current?.emit('chat-message', { roomId, userName, message: chatInput.trim() })
    setChatInput('')
  }

  const copyInviteLink = async () => {
    if (!roomId.trim()) { setRoomId(generateMeetingId()); }
    const url = new URL(window.location.href)
    url.searchParams.set('room', roomId.trim())
    // Optionally include name; omit to let invitee set theirs
    try {
      await navigator.clipboard.writeText(url.toString())
      setInviteCopied(true)
      systemMessage('Invite link copied to clipboard.')
      setTimeout(() => setInviteCopied(false), 2000)
    } catch {
      systemMessage('Unable to copy. Share this link: ' + url.toString())
    }
  }

  if (!joined) {
    return (
      <div className="join">
        <div className="form">
          <h2>Zoom Clone</h2>
          <input placeholder="Your name" value={userName} onChange={e => setUserName(e.target.value)} />
          <div style={{ display: 'flex', gap: 8 }}>
            <input placeholder="Meeting ID" value={roomId} onChange={e => setRoomId(e.target.value)} />
            <button type="button" className="btn btn-outline-secondary" onClick={() => setRoomId(generateMeetingId())}>Generate</button>
          </div>
          <button onClick={joinRoom}>Join / Create</button>
        </div>
      </div>
    )
  }

  return (
    <div className="container">
      <div className="left">
        <div className="video-grid">
          <div className="video-tile">
            <video
              ref={(el) => {
                localVideoRef.current = el
                if (el && localStreamRef.current) {
                  ;(el as HTMLVideoElement).srcObject = localStreamRef.current
                  ;(el as HTMLVideoElement).muted = true
                  ;(el as HTMLVideoElement).play().catch(() => {})
                }
              }}
              autoPlay
              playsInline
            />
          </div>
          {remoteStreams.map(rs => (
            <div key={rs.id} className="video-tile">
              <video ref={(el) => {
                if (el && rs.stream) { el.srcObject = rs.stream; el.play().catch(() => {}) }
              }} autoPlay playsInline />
            </div>
          ))}
        </div>
        <div className="controls">
          <button className={audioEnabled ? 'active' : ''} onClick={toggleAudio}>{audioEnabled ? 'Mute' : 'Unmute'}</button>
          <button className={videoEnabled ? 'active' : ''} onClick={toggleVideo}>{videoEnabled ? 'Stop Video' : 'Start Video'}</button>
          <button className={screenSharing ? 'active' : ''} onClick={toggleScreenShare}>{screenSharing ? 'Stop Share' : 'Share Screen'}</button>
          <button onClick={copyInviteLink}>{inviteCopied ? 'Copied!' : 'Copy Invite Link'}</button>
          <button onClick={leaveRoom}>Leave</button>
        </div>
      </div>
      <aside className="sidebar">
        <header>Chat</header>
        <div className="chat">
          {chat.map((m, i) => (
            <div key={i} className="msg">
              <div className="meta">{m.userName} · {new Date(m.timestamp).toLocaleTimeString()}</div>
              <div>{m.message}</div>
            </div>
          ))}
        </div>
        <div className="chat-input">
          <input placeholder="Type a message" value={chatInput} onChange={e => setChatInput(e.target.value)} onKeyDown={e => e.key === 'Enter' ? sendChat() : undefined} />
          <button onClick={sendChat}>Send</button>
        </div>
      </aside>
    </div>
  )
}