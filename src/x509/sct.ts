/*
Copyright 2023 The Sigstore Authors.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
import * as sigstore from '../types/sigstore';
import { crypto } from '../util';
import { ByteStream } from '../util/stream';

interface SCTOptions {
  version: number;
  logID: Buffer;
  timestamp: Buffer;
  extensions: Buffer;
  hashAlgorithm: number;
  signatureAlgorithm: number;
  signature: Buffer;
}

export class SignedCertificateTimestamp {
  readonly version: number;
  readonly logID: Buffer;
  readonly timestamp: Buffer;
  readonly extensions: Buffer;
  readonly hashAlgorithm: number;
  readonly signatureAlgorithm: number;
  readonly signature: Buffer;

  constructor(options: SCTOptions) {
    this.version = options.version;
    this.logID = options.logID;
    this.timestamp = options.timestamp;
    this.extensions = options.extensions;
    this.hashAlgorithm = options.hashAlgorithm;
    this.signatureAlgorithm = options.signatureAlgorithm;
    this.signature = options.signature;
  }

  get datetime(): Date {
    return new Date(Number(this.timestamp.readBigInt64BE()));
  }

  // Returns the hash algorithm used to generate the SCT's signature.
  // https://www.rfc-editor.org/rfc/rfc5246#section-7.4.1.4.1
  get algorithm(): string {
    switch (this.hashAlgorithm) {
      case 0:
        return 'none';
      case 1:
        return 'md5';
      case 2:
        return 'sha1';
      case 3:
        return 'sha224';
      case 4:
        return 'sha256';
      case 5:
        return 'sha384';
      case 6:
        return 'sha512';
      default:
        return 'unknown';
    }
  }

  public verify(
    preCert: Buffer,
    logs: sigstore.TransparencyLogInstance[]
  ): boolean {
    // Find key for the log reponsible for this signature
    const log = logs.find((log) => log.logId?.keyId.equals(this.logID));

    if (!log?.publicKey?.rawBytes) {
      throw new Error(`No key found for log: ${this.logID.toString('base64')}`);
    }

    const publicKey = crypto.createPublicKey(log.publicKey.rawBytes);

    // Assemble the digitally-signed struct (the data over which the signature
    // was generated).
    // https://www.rfc-editor.org/rfc/rfc6962#section-3.2
    const stream = new ByteStream();
    stream.appendChar(this.version);
    stream.appendChar(0x00); // SignatureType = certificate_timestamp(0)
    stream.appendView(this.timestamp);
    stream.appendUint16(0x01); // LogEntryType = precert_entry(1)
    stream.appendView(preCert);
    stream.appendUint16(this.extensions.byteLength);

    if (this.extensions.byteLength > 0) {
      stream.appendView(this.extensions);
    }

    return crypto.verifyBlob(
      stream.buffer,
      publicKey,
      this.signature,
      this.algorithm
    );
  }

  // Parses a SignedCertificateTimestamp from a buffer. SCTs are encoded using
  // TLS encoding which means the fields and lengths of most fields are
  // specified as part of the SCT and TLS specs.
  // https://www.rfc-editor.org/rfc/rfc6962#section-3.2
  // https://www.rfc-editor.org/rfc/rfc5246#section-7.4.1.4.1
  public static parse(buf: Buffer): SignedCertificateTimestamp {
    const stream = new ByteStream(buf);

    // Version - enum { v1(0), (255) }
    const version = stream.getUint8();

    // Log ID  - struct { opaque key_id[32]; }
    const logID = stream.getBlock(32);

    // Timestamp - uint64
    const timestamp = stream.getBlock(8);

    // Extensions - opaque extensions<0..2^16-1>;
    const extenstionLength = stream.getUint16();
    const extensions = stream.getBlock(extenstionLength);

    // Hash algo - enum { sha256(4), . . . (255) }
    const hashAlgorithm = stream.getUint8();

    // Signature algo - enum { anonymous(0), rsa(1), dsa(2), ecdsa(3), (255) }
    const signatureAlgorithm = stream.getUint8();

    // Signature  - opaque signature<0..2^16-1>;
    const sigLength = stream.getUint16();
    const signature = stream.getBlock(sigLength);

    // Check that we read the entire buffer
    if (stream.position !== buf.length) {
      throw new Error('SCT buffer length mismatch');
    }

    return new SignedCertificateTimestamp({
      version,
      logID,
      timestamp,
      extensions,
      hashAlgorithm,
      signatureAlgorithm,
      signature,
    });
  }
}
