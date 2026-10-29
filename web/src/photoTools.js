// Photos are shrunk in the browser before they leave the phone: less data to send, and redrawing on a canvas
// also drops EXIF and location. The server strips metadata again, so this is a courtesy, not the safeguard.
export const MAX_PHOTO_MB = 10
export const MAX_PHOTOS = 5

async function decode(file) {
  try { return await createImageBitmap(file, { imageOrientation: 'from-image' }) } catch { /* older browsers */ }
  const url = URL.createObjectURL(file)
  try {
    return await new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error('read'))
      img.src = url
    })
  } finally { URL.revokeObjectURL(url) }
}

export async function shrink(file, maxSide = 1600, quality = 0.85) {
  let img
  try { img = await decode(file) } catch { throw new Error(`We could not read "${file.name}". Use a JPEG, PNG or WebP photo.`) }
  const w0 = img.width || img.naturalWidth
  const h0 = img.height || img.naturalHeight
  const scale = Math.min(1, maxSide / Math.max(w0, h0))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(w0 * scale)
  canvas.height = Math.round(h0 * scale)
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
  const blob = await new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not prepare the photo.'))), 'image/jpeg', quality))
  return { blob, width: canvas.width, height: canvas.height }
}

export const blobToDataUrl = (blob) => new Promise((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(reader.result)
  reader.onerror = () => reject(new Error('Could not read the photo.'))
  reader.readAsDataURL(blob)
})
