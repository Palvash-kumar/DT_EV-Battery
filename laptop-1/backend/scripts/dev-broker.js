// Development-only MQTT broker (aedes) for working on Laptop 1 when
// Laptop 2's Mosquitto is not reachable. It accepts any username/password and
// has no ACLs, so never use it on a shared network or for the demo.
//
//   npm run dev:broker            -> listens on 1883
//   DEV_BROKER_PORT=1884 npm run dev:broker
import { createServer } from 'node:net';
import { Aedes } from 'aedes';

const port = Number(process.env.DEV_BROKER_PORT || 1883);
const host = process.env.DEV_BROKER_HOST || '127.0.0.1';

const broker = await Aedes.createBroker();
const server = createServer(broker.handle);

broker.on('client', (c) => console.log(`[dev-broker] connect    ${c.id}`));
broker.on('clientDisconnect', (c) => console.log(`[dev-broker] disconnect ${c.id}`));
broker.on('publish', (packet, client) => {
  if (!client || packet.topic.startsWith('$SYS')) return;
  console.log(`[dev-broker] ${client.id} -> ${packet.topic} (${packet.payload.length} B, qos ${packet.qos}${packet.retain ? ', retained' : ''})`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[dev-broker] port ${port} is already taken - probably a real Mosquitto is running. Use that, or set DEV_BROKER_PORT.`);
    process.exit(1);
  }
  throw err;
});

server.listen(port, host, () => {
  console.log(`[dev-broker] DEV ONLY - no auth, no ACL - mqtt://${host}:${port}`);
});

const stop = () => server.close(() => broker.close(() => process.exit(0)));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
