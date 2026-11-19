const fs = require('fs');
const want = !!(process.env.S3_ENDPOINT && process.env.S3_BUCKET && process.env.S3_KEY && process.env.S3_SECRET);
let S3, sdk, presign, enabled = false;
if (want) {
  try {
    sdk = require('@aws-sdk/client-s3');
    presign = require('@aws-sdk/s3-request-presigner').getSignedUrl;
    S3 = new sdk.S3Client({
      region: process.env.S3_REGION || 'auto',
      endpoint: process.env.S3_ENDPOINT,
      forcePathStyle: true,
      credentials: { accessKeyId: process.env.S3_KEY, secretAccessKey: process.env.S3_SECRET },
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED'
    });
    enabled = true;
  } catch (e) { console.error('S3 kutubxonasi yuklanmadi:', e.message); }
}
const Bucket = process.env.S3_BUCKET;
const cmd = (N, p) => new sdk[N](Object.assign({ Bucket }, p));
module.exports = {
  enabled,
  async putFile(Key, file, ContentType) {
    await S3.send(cmd('PutObjectCommand', { Key, Body: fs.createReadStream(file), ContentLength: fs.statSync(file).size, ContentType }));
  },
  async getObject(Key, Range) { return S3.send(cmd('GetObjectCommand', Object.assign({ Key }, Range ? { Range } : {}))); },
  async del(Key) { await S3.send(cmd('DeleteObjectCommand', { Key })); },
  signedGet(Key, o) {
    o = o || {};
    const p = { Key };
    if (o.filename) p.ResponseContentDisposition = `attachment; filename="${o.filename}"`;
    return presign(S3, cmd('GetObjectCommand', p), { expiresIn: o.expires || 21600 });
  },
  async mpInit(Key, ContentType) { const r = await S3.send(cmd('CreateMultipartUploadCommand', { Key, ContentType })); return r.UploadId; },
  partUrl(Key, UploadId, PartNumber) { return presign(S3, cmd('UploadPartCommand', { Key, UploadId, PartNumber }), { expiresIn: 21600 }); },
  async mpComplete(Key, UploadId, Parts) { await S3.send(cmd('CompleteMultipartUploadCommand', { Key, UploadId, MultipartUpload: { Parts } })); },
  async mpAbort(Key, UploadId) { await S3.send(cmd('AbortMultipartUploadCommand', { Key, UploadId })); }
};
