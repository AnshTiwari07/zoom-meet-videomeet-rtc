import express from 'express'
import http from 'http'
import { Server } from 'socket.io'
import cors from 'cors'

const app = express()
app.use(cors({ origin: ['http://localhost:5173'], credentials: true }))

app.get('/', (_req, res) => {
  res.json({ ok: true })
})

const server = http.createServer(app)
const io = new Server(server, {
  cors: { origin: ['http://localhost:5173'], methods: ['GET', 'POST'] }
})

io.on('connection', (socket) => {
  let currentRoom = null
  let currentName = 'Anonymous'

  socket.on('join-room', ({ roomId, userName }) => {
    currentRoom = roomId
    currentName = userName || 'Anonymous'
    socket.join(roomId)
    const room = io.sockets.adapter.rooms.get(roomId)
    const users = room ? Array.from(room.keys()).filter(id => id !== socket.id) : []
    socket.emit('existing-users', { users })
    socket.to(roomId).emit('user-joined', { userId: socket.id, userName: currentName })
  })

  socket.on('offer', ({ to, sdp }) => {
    io.to(to).emit('offer', { from: socket.id, sdp })
  })

  socket.on('answer', ({ to, sdp }) => {
    io.to(to).emit('answer', { from: socket.id, sdp })
  })

  socket.on('ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('ice-candidate', { from: socket.id, candidate })
  })

  socket.on('chat-message', ({ roomId, userName, message }) => {
    io.to(roomId).emit('chat-message', { userName, message, timestamp: Date.now() })
  })

  socket.on('leave-room', ({ roomId }) => {
    try { socket.leave(roomId) } catch {}
  })

  socket.on('disconnect', () => {
    if (currentRoom) {
      socket.to(currentRoom).emit('user-left', { userId: socket.id, userName: currentName })
    }
  })
})

const PORT = process.env.PORT || 3001
server.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`)
})