import { Server } from 'socket.io';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATION = /^[A-Za-z0-9_-]{1,64}$/;

// Browsers join rooms for the station they are looking at and for the
// requests they created, so an update only goes to the pages that care.
export function attachRealtime(httpServer, { config, logger }) {
  const log = logger.child({ component: 'socket' });
  const io = new Server(httpServer, {
    cors: { origin: config.corsOrigins },
    serveClient: false,
  });

  io.on('connection', (socket) => {
    socket.on('subscribe', (topic = {}, ack) => {
      const joined = [];
      if (typeof topic.stationId === 'string' && STATION.test(topic.stationId)) {
        socket.join(`station:${topic.stationId}`);
        joined.push(`station:${topic.stationId}`);
      }
      if (typeof topic.requestId === 'string' && UUID.test(topic.requestId)) {
        socket.join(`request:${topic.requestId}`);
        joined.push(`request:${topic.requestId}`);
      }
      if (typeof ack === 'function') ack({ joined });
    });
    socket.on('unsubscribe', (topic = {}) => {
      if (topic.stationId) socket.leave(`station:${topic.stationId}`);
      if (topic.requestId) socket.leave(`request:${topic.requestId}`);
    });
  });

  return {
    io,
    toStation(stationId, event, data) {
      io.to(`station:${stationId}`).emit(event, data);
    },
    prediction(view) {
      io.to(`request:${view.requestId}`).to(`station:${view.stationId}`).emit('prediction:update', view);
    },
    broadcast(event, data) {
      io.emit(event, data);
    },
    close() {
      log.debug('closing socket server');
      return new Promise((resolve) => io.close(() => resolve()));
    },
  };
}
