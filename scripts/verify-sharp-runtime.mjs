import sharp from 'sharp'

const { data, info } = await sharp({
  create: {
    width: 2,
    height: 2,
    channels: 4,
    background: { r: 32, g: 96, b: 160, alpha: 1 },
  },
})
  .png()
  .toBuffer({ resolveWithObject: true })

if (info.format !== 'png' || info.width !== 2 || info.height !== 2 || data.length === 0) {
  throw new Error(`Sharp runtime smoke test returned an invalid image: ${JSON.stringify(info)}`)
}

console.log(`[runtime] verified Sharp ${sharp.versions.sharp} with libvips ${sharp.versions.vips}`)
