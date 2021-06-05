import { Socket, isIPv4 } from 'net'
import { Transform, TransformCallback } from 'stream'
import { createSocket as createDgram } from 'dgram'
import dns, { SrvRecord } from 'dns'
import { promisify } from 'util'

const debug = require('debug')('lgou2w:minecraft-ping')
const lookupDns = promisify(dns.lookup)
const resolveDnsSrv = promisify(dns.resolveSrv)

/// - Type declaration

interface ServerStatus {
  host: string
  port: number
  ipv4: string
  latency: number
  description: any
  version: {
    name: string
    protocol: number
  }
  players: {
    online: number
    max: number
  }
}

type Options = {
  host: string
  port?: number
  timeout?: number
}

/// - Java Edition

interface JavaEditionServerStatus extends ServerStatus {
  description: string | Record<string, any>
  players: {
    online: number
    max: number
    sample?: { id: string, name: string }[]
  }
  favicon?: string
  srv?: {
    priority: number
    weight: number
    port: number
    name: string
  }
  [key: string]: any
}

type JavaEditionOptions = Options & { noSrv?: boolean, protocol?: number }

async function pingJava (opts: JavaEditionOptions): Promise<JavaEditionServerStatus> {
  if (opts.protocol && typeof opts.protocol !== 'number') {
    return Promise.reject(new Error('Invalid client protocol: ' + opts.protocol + '. (Current: ' + typeof opts.protocol + ', Expected: number)'))
  }
  let ip = opts.host
  let port = opts.port || 25565 // Java edition default port
  let srv: SrvRecord
  if (!isIPv4(ip) && !opts.noSrv) {
    const target = '_minecraft._tcp.' + ip
    debug(':resolve dns srv from host:', target)
    try {
      const addresses = await resolveDnsSrv(target)
      if (addresses.length > 0) {
        srv = addresses[0]
        ip = srv.name
        port = srv.port
        debug(':resolved srv:', srv)
      }
    } catch (err) {
      debug(':resolve failed:', err)
    }
  }
  return new Promise((resolve, reject) => {
    debug(':ready to connect')
    try {
      let end = 0
      const start = Date.now()
      const socket = new Socket()
      const reader = new ChunkReader()
      socket.setNoDelay(true)
      socket.pipe(reader)
      socket.once('error', reject)
      reader.on('data', (data: Buffer) => {
        debug(':read response')
        // do not send ping packet, because some plugins will directly
        // disconnect after replying to the response
        socket.destroy()
        // Read response
        let [packetId, offset] = readVarInt(data, 0)
        ;[, offset] = readVarInt(data, offset)
        if (packetId !== 0) {
          reject(new Error('Bad packet id: ' + packetId))
          return
        }
        const response = data.slice(offset, data.length).toString('utf8')
        const status = JSON.parse(response) as JavaEditionServerStatus
        status.host = opts.host
        status.port = socket.remotePort || port
        status.ipv4 = socket.remoteAddress || opts.host
        status.latency = end - start
        status.srv = srv
        resolve(status)
      })
      opts.timeout !== undefined && debug(':timeout:', opts.timeout)
      opts.timeout !== undefined && socket.setTimeout(opts.timeout, () => {
        socket.destroy()
        reject(new Error('Socket timeout'))
      })
      debug(':connecting...')
      socket.connect(port, ip, () => {
        // Connected
        debug(':connected, sending packet...')
        end = Date.now()
        // Send Handshake & Request
        const hostBuf = Buffer.from(ip)
        const portBuf = Buffer.alloc(2)
        portBuf.writeUInt16BE(port)
        const handshakeBuf = Buffer.concat([
          writeVarInt(0),
          writeVarInt(opts.protocol || 754),
          writeVarInt(hostBuf.length),
          hostBuf,
          portBuf,
          writeVarInt(1)
        ])
        socket.write(Buffer.concat([writeVarInt(handshakeBuf.length), handshakeBuf]))
        socket.write(Buffer.from([1, 0]))
      })
    } catch (err) {
      reject(err)
    }
  })
}

function writeVarInt (value: number): Buffer {
  const bytes: number[] = []
  do {
    let b = value & 127
    value >>>= 7
    if (value !== 0) b |= 128
    bytes.push(b)
  } while (value !== 0)
  return Buffer.from(bytes)
}

function readVarInt (buf: Buffer, offset: number): [number, number] {
  let numRead = 0
  let result = 0
  let b = 0
  do {
    b = buf.readUInt8(offset++)
    result |= (b & 127) << (7 * numRead++)
    if (numRead > 5) throw new Error('VarInt too big')
  } while ((b & 128) !== 0)
  return [result, offset]
}

class ChunkReader extends Transform {
  private buffer = Buffer.alloc(0)
  private transforming = false
  private flushCallback?: () => void

  async _transform (chunk: any, encoding: string, callback: TransformCallback) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    this.transforming = true

    let offset = 0
    let length: number
    while (true) {
      const packetStart = offset
      try {
        [length, offset] = readVarInt(this.buffer, offset)
      } catch (err) {
        break
      }

      if (offset + length > this.buffer.length) {
        offset = packetStart
        break
      }

      try {
        this.push(this.buffer.slice(offset, offset + length))
      } catch (err) {
        return this.destroy(err)
      }
      offset += length
      await Promise.resolve()
    }
    this.buffer = this.buffer.slice(offset)
    this.flushCallback && this.flushCallback()
    this.transforming = false
    callback()
  }

  flush (callback: TransformCallback) {
    if (this.transforming) this.flushCallback = callback
    else callback()
  }
}

/// - Legacy Java Edition

interface LegacyJavaEditionServerStatus extends ServerStatus {
  description: string
}

async function pingLegacyB18To13 (opts: Options): Promise<LegacyJavaEditionServerStatus> {
  return pingLegacy(Buffer.from([0xFE]), opts)
}

async function pingLegacy14To15 (opts: Options): Promise<LegacyJavaEditionServerStatus> {
  return pingLegacy(Buffer.from([0xFE, 0x01]), opts)
}

async function pingLegacy16 (opts: Options): Promise<LegacyJavaEditionServerStatus> {
  const hostBuf = writeUTF16BE(opts.host)
  const portBuf = Buffer.alloc(4)
  const payloadLenBuf = Buffer.alloc(2)
  payloadLenBuf.writeUInt16BE(hostBuf.length + 7, 0)
  portBuf.writeInt32BE(opts.port || 25565, 0)
  return pingLegacy(Buffer.concat([
    Buffer.from([
      0xFE, // Packet Identifier
      0x01, // Server List Ping
      0xFA, // Plugin Message
      0x00, 0x0B, // MC|PingHost (UTF-16BE) Length
      0x00, 0x4D, 0x00, 0x43, 0x00, 0x7C, 0x00, 0x50, 0x00, 0x69, 0x00,
      0x6E, 0x00, 0x67, 0x00, 0x48, 0x00, 0x6F, 0x00, 0x73, 0x00, 0x74
    ]),
    payloadLenBuf, // len(UTF-16BE(host)) + 7
    Buffer.from([0x4E]), // Protocol Version (0x4E = 78 = 1.6.4)
    hostBuf,
    portBuf
  ]), opts)
}

async function pingLegacy (packet: Buffer, opts: Options): Promise<LegacyJavaEditionServerStatus> {
  const ip = opts.host
  const port = opts.port || 25565 // Java edition default port
  return new Promise((resolve, reject) => {
    debug(':ready to connect')
    try {
      let end = 0
      const start = Date.now()
      const socket = new Socket()
      socket.setNoDelay(true)
      socket.once('error', reject)
      socket.on('data', (data: Buffer) => {
        debug(':read response')
        socket.destroy()
        const response = readLegacyResponse(data, reject)
        if (!response) return // reject error
        const status = <LegacyJavaEditionServerStatus> {}
        status.host = opts.host
        status.port = socket.remotePort || port
        status.ipv4 = socket.remoteAddress || opts.host
        status.latency = end - start
        status.version = response.version
        status.players = response.players
        status.description = response.description
        resolve(status)
      })
      opts.timeout !== undefined && debug(':timeout:', opts.timeout)
      opts.timeout !== undefined && socket.setTimeout(opts.timeout, () => {
        socket.destroy()
        reject(new Error('Socket timeout'))
      })
      debug(':connecting...')
      socket.connect(port, ip, () => {
        // Connected
        debug(':connected, sending packet...')
        end = Date.now()
        socket.write(packet)
      })
    } catch (err) {
      reject(err)
    }
  })
}

function readLegacyResponse (buf: Buffer, reject: (err: Error) => void) {
  const packetId = buf.readUInt8(0)
  if (packetId !== 0xFF) {
    return reject(new Error(`Bad packet id: ${packetId}`))
  }

  const payloadLen = buf.readUInt16BE(1)
  const payload = readUTF16BE(buf.slice(3))
  if (payload.length !== payloadLen) {
    return reject(new Error(`Bad packet payload length. (expected: ${payloadLen}, current: ${payload.length})`))
  }

  if (payload[0] === '\xa7' && payload[1] === '1') {
    const pairs = payload.slice(3).split('\0')
    if (pairs.length !== 5) {
      return reject(new Error(`Bad packet payload entries: ${pairs} (expected: 5, current: ${pairs.length}`))
    }
    return {
      version: { protocol: parseInt(pairs[0]), name: pairs[1] },
      players: { max: parseInt(pairs[4]), online: parseInt(pairs[3]) },
      description: pairs[2]
    }
  } else {
    const pairs = payload.split('\xa7')
    if (pairs.length !== 3) {
      return reject(new Error(`Bad packet payload entries: ${pairs} (expected: 3, current: ${pairs.length}`))
    }
    return {
      version: { protocol: 0, name: '' },
      players: { max: parseInt(pairs[2]), online: parseInt(pairs[1]) },
      description: pairs[0]
    }
  }
}

function writeUTF16BE (str: string): Buffer {
  const buf = Buffer.from(str, 'ucs2')
  for (let i = 0; i < buf.length; i += 2) {
    const tmp = buf[i]
    buf[i] = buf[i + 1]
    buf[i + 1] = tmp
  } return buf
}

function readUTF16BE (buf: Buffer): string {
  if (buf.length <= 0) return ''
  const data = Buffer.alloc(buf.length + 1)
  let j = 0
  for (let i = 0; i < buf.length; i += 2, j += 2) {
    data[j] = buf[i + 1]
    data[j + 1] = buf[i]
  }
  return data.slice(0, j).toString('ucs2')
}

/// - Bedrock Edition

interface BedrockEditionServerStatus extends ServerStatus {
  description: string
  serverId: string
  gameId: string
  payload: string[]
}

async function pingBedrock (opts: Options): Promise<BedrockEditionServerStatus> {
  let ip = opts.host
  const port = opts.port || 19132 // Bedrock default port
  if (!isIPv4(ip)) {
    debug(':resolve dns from host:', ip)
    const address = await lookupDns(opts.host)
    ip = address.address
    debug(':resolved: %s -> %s', opts.host, ip)
  }
  return new Promise((resolve, reject) => {
    debug(':ready to listen')
    try {
      let timeout: any
      const start = Date.now()
      const client = createDgram('udp4')
      client.once('error', reject)
      client.on('message', (msg, rinfo) => {
        debug(':read response')
        client.close()
        timeout && clearTimeout(timeout)
        const pong = readBedrockPacketPong(msg, reject)
        if (!pong) return // reject error
        const status = <BedrockEditionServerStatus> {}
        status.host = opts.host
        status.port = rinfo.port || port
        status.ipv4 = rinfo.address || ip
        status.latency = Date.now() - start
        status.description = pong.serverName
        status.version = {
          name: pong.serverVersion,
          protocol: parseInt(pong.protocolVersion)
        }
        status.players = {
          online: parseInt(pong.online),
          max: parseInt(pong.max)
        }
        status.serverId = pong.serverId
        status.gameId = pong.gameId
        status.payload = pong.payload
        resolve(status)
      })
      client.on('listening', () => {
        opts.timeout !== undefined && debug(':timeout:', opts.timeout)
        timeout = opts.timeout === undefined
          ? undefined
          : setTimeout(() => {
            client.close()
            reject(new Error('Timeout'))
          }, opts.timeout)
        debug(':listened, sending packet...')
        const packet = writeBedrockPacketPing(start)
        client.send(packet, 0, packet.length, port, ip)
      })
      debug(':listening...')
      client.bind()
    } catch (err) {
      reject(err)
    }
  })
}

const BedrockEditionPacketMagic = [
  0x00, 0xFF, 0xFF, 0x00, 0xFE, 0xFE, 0xFE, 0xFE,
  0xFD, 0xFD, 0xFD, 0xFD, 0x12, 0x34, 0x56, 0x78
]

// Ping:
//
// 0x01     : Packet Id (byte)
// 8  bytes : Timestamp (long)
// 16 bytes : Magic data (bytes)
//
function writeBedrockPacketPing (timestamp: number): Buffer {
  const timestampBuf = Buffer.alloc(8)
  timestampBuf.writeBigInt64BE(BigInt(timestamp))
  return Buffer.concat([
    Buffer.from([0x01]),
    timestampBuf,
    Buffer.from(BedrockEditionPacketMagic)
  ])
}

// Pong:
//
// 0x1C     : Packet Id (byte)
// 8  bytes : Timestamp (long)
// 8  bytes : Server Id (long)
// 16 bytes : Magic data (bytes)
// 2  bytes : Payload length (short)
// .. bytes : Payload (string)
//
function readBedrockPacketPong (buf: Buffer, reject: (err: Error) => void) {
  const packetId = buf.readInt8(0)
  if (packetId !== 0x1C) {
    return reject(new Error(`Bad packet id: ${packetId}`))
  }

  const timestamp = buf.readBigInt64BE(1).toString()
  const serverId = buf.readBigInt64BE(9).toString() + 'n' // bigint

  if (buf.compare(Buffer.from(BedrockEditionPacketMagic), 0, BedrockEditionPacketMagic.length, 17, 33) !== 0) {
    return reject(new Error(`Bad packet magic data: ${buf.slice(17, 33).toString('hex')}`))
  }

  const payloadLen = buf.readInt16BE(33)
  const payload = buf.slice(35, payloadLen).toString().split(/;/g)
  if (payload.length < 6) {
    return reject(new Error(`Bad packet payload entries: ${payload}. (expected: 6, current: ${payload.length})`))
  }

  const [gameId, serverName, protocolVersion, serverVersion, online, max] = payload
  return {
    timestamp,
    serverId,
    gameId,
    serverName,
    protocolVersion,
    serverVersion,
    online,
    max,
    payload
  }
}

/// - Ping fn

enum Server {
  LEGACY_B1_8_TO_1_3 = 0,
  LEGACY_1_4_TO_1_5 = 1,
  LEGACY_1_6 = 2,
  JAVA = 3,
  BEDROCK = 10
}

async function ping (server: Server.JAVA, hostOrOpts: string | JavaEditionOptions): Promise<JavaEditionServerStatus>
async function ping (server: Server.LEGACY_1_6, hostOrOpts: string | Options): Promise<LegacyJavaEditionServerStatus>
async function ping (server: Server.LEGACY_1_4_TO_1_5, hostOrOpts: string | Options): Promise<LegacyJavaEditionServerStatus>
async function ping (server: Server.LEGACY_B1_8_TO_1_3, hostOrOpts: string | Options): Promise<LegacyJavaEditionServerStatus>
async function ping (server: Server.BEDROCK, hostOrOpts: string | Options): Promise<BedrockEditionServerStatus>
async function ping (server: Server, hostOrOpts: string | Options): Promise<ServerStatus> {
  debug(':ping server:', Server[server])
  const opts = parseOptions(hostOrOpts)
  if (!opts.host) throw new Error('Invalid server host: ' + opts.host)
  switch (server) {
    case Server.LEGACY_B1_8_TO_1_3: return pingLegacyB18To13(opts)
    case Server.LEGACY_1_4_TO_1_5: return pingLegacy14To15(opts)
    case Server.LEGACY_1_6: return pingLegacy16(opts)
    case Server.JAVA: return pingJava(opts)
    case Server.BEDROCK: return pingBedrock(opts)
    default: throw new Error('Invalid server type: ' + server)
  }
}

function parseOptions (hostOrOpts: string | Options): Options {
  debug(':parse options:', hostOrOpts)
  if (!hostOrOpts) throw new Error('Invalid server host or options: ' + hostOrOpts)
  if (typeof hostOrOpts === 'object') return hostOrOpts
  else if (typeof hostOrOpts !== 'string') throw new Error('Invalid server host or options type: ' + typeof hostOrOpts)

  const [host, port] = hostOrOpts.split(':', 2)
  const _port = port ? parseInt(port) : undefined

  if (_port !== undefined && isNaN(_port)) throw new Error('Invalid server port value: ' + port)
  debug(':parsed host: %s, port: %s', host, _port)
  return {
    host,
    port: _port
  }
}

export { Server, ServerStatus, Options, JavaEditionServerStatus, LegacyJavaEditionServerStatus, BedrockEditionServerStatus }
export default ping
