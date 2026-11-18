import { io } from 'socket.io-client';

// One Socket.IO connection for the whole app, created on first use.
// Rooms are re-joined after every reconnect.
let socket;
const rooms = new Map(); // key -> { stationId } | { requestId }, with a ref count

function joinAll() {
  for (const { topic } of rooms.values()) socket.emit('subscribe', topic);
}

export function getSocket() {
  if (!socket) {
    socket = io({ path: '/socket.io', transports: ['websocket', 'polling'] });
    socket.on('connect', joinAll);
  }
  return socket;
}

// Join a room while a component is mounted. Returns the cleanup function.
export function joinRoom(topic) {
  const key = JSON.stringify(topic);
  const s = getSocket();
  const entry = rooms.get(key) || { topic, count: 0 };
  entry.count += 1;
  rooms.set(key, entry);
  if (entry.count === 1 && s.connected) s.emit('subscribe', topic);
  return () => {
    entry.count -= 1;
    if (entry.count === 0) {
      rooms.delete(key);
      s.emit('unsubscribe', topic);
    }
  };
}
