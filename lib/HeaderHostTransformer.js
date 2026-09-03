import { Transform } from 'stream';

export default class HeaderHostTransformer extends Transform {
  constructor(opts = {}) {
    super(opts);
    this.host = (opts.host || 'localhost').replace(/[\r\n]/g, '');
    this.replaced = false;
    this.headerBuffer = Buffer.alloc(0);
  }

  _transform(chunk, encoding, callback) {
    if (this.replaced) {
      return callback(null, chunk);
    }

    this.headerBuffer = Buffer.concat([this.headerBuffer, chunk]);
    const headerEndIndex = this.headerBuffer.indexOf('\r\n\r\n');

    if (headerEndIndex !== -1) {
      const headerPart = this.headerBuffer.slice(0, headerEndIndex).toString('utf8');
      const bodyPart = this.headerBuffer.slice(headerEndIndex);

      const replacedHeaders = headerPart.replace(/(^|\r\n)(Host:[ \t]*)[^\r\n]+/i, (match, prefix, hostHeader) => {
        return prefix + hostHeader + this.host;
      });

      this.replaced = true;
      this.push(Buffer.from(replacedHeaders, 'utf8'));
      this.push(bodyPart);
      this.headerBuffer = null;
      return callback();
    } else {
      if (this.headerBuffer.length > 16384) {
        this.replaced = true;
        this.push(this.headerBuffer);
        this.headerBuffer = null;
      }
      callback();
    }
  }

  _flush(callback) {
    if (this.headerBuffer && this.headerBuffer.length > 0) {
      this.push(this.headerBuffer);
      this.headerBuffer = null;
    }
    callback();
  }
}