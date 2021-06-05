import ping, { Server } from '../src'

const debug = require('debug')('lgou2w:minecraft-ping:test')

ping(Server.JAVA, { host: 'mc.hypixel.net', noSrv: true })
  .then(debug)
  .catch(debug)
