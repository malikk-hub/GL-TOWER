// Central configuration, read from environment variables (see ../.env.example)
module.exports = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: process.env.DATABASE_URL || 'postgres://gltowers:gltowers@localhost:5432/gltowers',
  mqtt: {
    url: process.env.MQTT_URL || 'mqtt://localhost:1883',
    username: process.env.MQTT_USERNAME || 'api',
    password: process.env.MQTT_PASSWORD || 'api-dev-pass',
    // Topic layout: gltowers/<site>/<towerId>/<sensors|state|cmd>
    site: process.env.MQTT_SITE || 'main',
  },
  // Folder with the web application (index.html), served on "/"
  webDir: process.env.WEB_DIR || require('path').join(__dirname, '..', '..', 'web'),
  // A tower whose node has not published for this long is considered stale
  staleAfterSeconds: Number(process.env.STALE_AFTER_SECONDS || 120),
};
