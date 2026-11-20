/** Shared test fixtures. */

/**
 * Build a PNG header that passes signature + IHDR dimension parsing.
 * @param {number} width - image width.
 * @param {number} height - image height.
 * @returns {Uint8Array} encoded header bytes.
 */
export function pngBytes(width = 1024, height = 768) {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0x00, 0x00, 0x00, 0x0d], 8)
  bytes.set([0x49, 0x48, 0x44, 0x52], 12)
  const view = new DataView(bytes.buffer)
  view.setUint32(16, width)
  view.setUint32(20, height)
  return bytes
}

/**
 * Minimal response stand-in for a mocked fetch.
 * @param {object} init - response fields.
 * @returns {object} response-like object.
 */
export function fakeResponse({ ok = true, status = 200, body = {}, bytes, contentType = 'application/json', headers = {} }) {
  return {
    ok,
    status,
    headers: {
      get(name) {
        if (name.toLowerCase() === 'content-type') return contentType
        return headers[name.toLowerCase()] ?? null
      },
    },
    async json() {
      return body
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body)
    },
    async arrayBuffer() {
      const value = bytes ?? new Uint8Array()
      return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
    },
  }
}