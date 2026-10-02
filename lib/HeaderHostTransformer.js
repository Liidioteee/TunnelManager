import net from 'net';
import { Transform } from 'stream';

const CRLF = Buffer.from('\r\n');
const HEADERS_END = Buffer.from('\r\n\r\n');
const MAX_HEADER_SIZE = 16384;
const MAX_LINE_SIZE = 4096;

// Разбирает поток HTTP/1.1-запросов: сообщает о каждом запросе событием
// 'request' ({ method, path }) и, если задан host, подменяет заголовок Host.
//
// localtunnel держит соединения открытыми (keep-alive) и шлёт по одному
// сокету много запросов подряд, поэтому поток разбирается как HTTP:
// после заголовков пропускается тело (Content-Length или chunked),
// и следующий запрос снова обрабатывается. После Upgrade (WebSocket)
// и при любых непонятных данных поток дальше передаётся без изменений.
export default class HeaderHostTransformer extends Transform {
  constructor(opts = {}) {
    super(opts);
    // Без host поток не меняется — только разбирается (событие 'request')
    const host = opts.host ? String(opts.host).replace(/[\r\n]/g, '') : '';
    // В заголовке Host IPv6-адрес записывается в квадратных скобках
    this.host = net.isIPv6(host) ? `[${host}]` : host;
    // headers | body | chunk-size | chunk-data | chunk-trailer | passthrough
    this.state = 'headers';
    this.buffer = Buffer.alloc(0);
    this.remaining = 0;
  }

  _transform(chunk, encoding, callback) {
    this.buffer = this.buffer.length > 0 ? Buffer.concat([this.buffer, chunk]) : chunk;
    while (this.buffer.length > 0 && this._step()) {
      // каждый шаг обрабатывает часть буфера; false — нужно больше данных
    }
    callback();
  }

  _flush(callback) {
    if (this.buffer.length > 0) {
      this.push(this.buffer);
      this.buffer = Buffer.alloc(0);
    }
    callback();
  }

  // Отдаёт первые n байт буфера дальше без изменений
  _forward(n) {
    this.push(this.buffer.subarray(0, n));
    this.buffer = this.buffer.subarray(n);
  }

  _passthrough() {
    this.state = 'passthrough';
    this._forward(this.buffer.length);
  }

  _step() {
    switch (this.state) {
      case 'headers': return this._readHeaders();
      case 'body': return this._readBody('headers');
      case 'chunk-data': return this._readBody('chunk-size');
      case 'chunk-size': return this._readChunkSize();
      case 'chunk-trailer': return this._readTrailerLine();
      default:
        this._forward(this.buffer.length);
        return false;
    }
  }

  _readHeaders() {
    const end = this.buffer.indexOf(HEADERS_END);
    if (end === -1) {
      if (this.buffer.length > MAX_HEADER_SIZE) this._passthrough();
      return false;
    }

    // latin1 сохраняет байты один в один, в отличие от utf8
    const head = this.buffer.subarray(0, end).toString('latin1');
    this.buffer = this.buffer.subarray(end + HEADERS_END.length);

    const requestLine = head.replace(/^(\r\n)+/, '').split('\r\n', 1)[0];
    const request = requestLine.match(/^([A-Za-z]+) (\S+) HTTP\/\d\.\d$/);
    if (request) {
      this.emit('request', { method: request[1], path: request[2] });
    }

    const replaced = this.host
      ? head.replace(/(^|\r\n)(Host:[ \t]*)[^\r\n]+/i, (match, prefix, name) => prefix + name + this.host)
      : head;
    this.push(Buffer.from(`${replaced}\r\n\r\n`, 'latin1'));

    this._chooseBodyState(head);
    return true;
  }

  _chooseBodyState(head) {
    const headers = {};
    for (const line of head.split('\r\n').slice(1)) {
      const colon = line.indexOf(':');
      if (colon > 0) {
        headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
    }

    if ('upgrade' in headers || /^CONNECT /i.test(head.trimStart())) {
      this.state = 'passthrough';
      return;
    }

    if ('transfer-encoding' in headers) {
      const codings = headers['transfer-encoding'].toLowerCase().split(',').map(s => s.trim());
      // Длину тела без chunked последним определить нельзя
      this.state = codings[codings.length - 1] === 'chunked' ? 'chunk-size' : 'passthrough';
      return;
    }

    if ('content-length' in headers) {
      const values = [...new Set(headers['content-length'].split(',').map(s => s.trim()))];
      if (values.length !== 1 || !/^\d{1,15}$/.test(values[0])) {
        this.state = 'passthrough';
        return;
      }
      this.remaining = Number(values[0]);
      this.state = this.remaining > 0 ? 'body' : 'headers';
      return;
    }

    // Запрос без Content-Length и Transfer-Encoding не имеет тела
    this.state = 'headers';
  }

  _readBody(nextState) {
    const n = Math.min(this.remaining, this.buffer.length);
    this._forward(n);
    this.remaining -= n;
    if (this.remaining === 0) this.state = nextState;
    return true;
  }

  // Возвращает длину строки до CRLF или -1, если строка ещё не пришла целиком
  _lineLength() {
    const idx = this.buffer.indexOf(CRLF);
    if (idx === -1 && this.buffer.length > MAX_LINE_SIZE) this._passthrough();
    return idx;
  }

  _readChunkSize() {
    const len = this._lineLength();
    if (len === -1) return false;

    const size = this.buffer.subarray(0, len).toString('latin1').split(';')[0].trim();
    if (!/^[0-9a-f]{1,12}$/i.test(size)) {
      this._passthrough();
      return false;
    }

    this._forward(len + CRLF.length);
    const bytes = parseInt(size, 16);
    if (bytes === 0) {
      this.state = 'chunk-trailer';
    } else {
      this.remaining = bytes + CRLF.length; // данные чанка и CRLF после них
      this.state = 'chunk-data';
    }
    return true;
  }

  // Трейлеры после последнего чанка заканчиваются пустой строкой
  _readTrailerLine() {
    const len = this._lineLength();
    if (len === -1) return false;
    this._forward(len + CRLF.length);
    if (len === 0) this.state = 'headers';
    return true;
  }
}
