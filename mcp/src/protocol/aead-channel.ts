import { createCipheriv, createDecipheriv } from "node:crypto";
import { MijiaFlowError } from "../errors.js";
import { concatBytes, readUint32Le, uint32Le, wipe } from "../util/bytes.js";

const MAX_COUNTER = 0xffff_ffff;

export class AeadChannel {
  readonly #key: Uint8Array;
  readonly #salt: Uint8Array;
  #sendCounter = 1;
  #receiveCounter = 0;
  #disposed = false;

  constructor(key: Uint8Array, salt: Uint8Array) {
    if (key.length !== 16) {
      throw new TypeError("AES-128-GCM key must be 16 bytes");
    }
    if (salt.length !== 8) {
      throw new TypeError("AES-128-GCM salt must be 8 bytes");
    }
    this.#key = Uint8Array.from(key);
    this.#salt = Uint8Array.from(salt);
  }

  encrypt(plaintext: Uint8Array): Uint8Array {
    this.#assertUsable();
    if (this.#sendCounter > MAX_COUNTER) {
      throw new MijiaFlowError("AES-GCM send counter exhausted", "COUNTER_EXHAUSTED");
    }
    const counter = this.#sendCounter++;
    const counterBytes = uint32Le(counter);
    const cipher = createCipheriv("aes-128-gcm", this.#key, concatBytes(this.#salt, counterBytes), {
      authTagLength: 16,
    });
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return concatBytes(counterBytes, ciphertext, cipher.getAuthTag());
  }

  decrypt(message: Uint8Array): Uint8Array {
    this.#assertUsable();
    if (message.length < 20) {
      throw new MijiaFlowError("Encrypted frame is truncated", "INVALID_CIPHERTEXT");
    }
    const counter = readUint32Le(message);
    if (counter === 0 || counter <= this.#receiveCounter) {
      throw new MijiaFlowError("Encrypted frame counter is replayed or stale", "REPLAY_DETECTED");
    }
    const tagOffset = message.length - 16;
    const decipher = createDecipheriv(
      "aes-128-gcm",
      this.#key,
      concatBytes(this.#salt, uint32Le(counter)),
      { authTagLength: 16 },
    );
    decipher.setAuthTag(message.subarray(tagOffset));
    try {
      const plaintext = Buffer.concat([
        decipher.update(message.subarray(4, tagOffset)),
        decipher.final(),
      ]);
      this.#receiveCounter = counter;
      return Uint8Array.from(plaintext);
    } catch {
      throw new MijiaFlowError("AES-GCM authentication failed", "AUTHENTICATION_FAILED");
    }
  }

  dispose(): void {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    wipe(this.#key);
    wipe(this.#salt);
  }

  #assertUsable(): void {
    if (this.#disposed) {
      throw new MijiaFlowError("Cipher has been disposed", "SESSION_CLOSED");
    }
  }
}
