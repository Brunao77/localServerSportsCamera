const path = require("path");
const fs = require("fs");

let maxRetries = 3

const uploadFile = async (filePath, s3Key, retries = 0) => {
  try {
    const res = await fetch(`https://sportscamera.vercel.app/api/s3/getPresignedURL/${s3Key}`);
    if (res.ok) {
      const { signedURL } = await res.json();
      const fileContent = fs.readFileSync(filePath);
      const resSign = await fetch(signedURL, {
        method: 'PUT',
        headers: {
          "Content-Type": "application/octet-stream"
        },
        body: fileContent
      });

      if (resSign.ok) {
        fs.unlinkSync(filePath);
      } else {
        throw new Error(`Failed to upload file to S3: ${resSign.statusText}`);
      }
    } else {
      throw new Error(`Failed to get presigned URL: ${res.statusText}`);
    }
  } catch (error) {
    console.error("Error al subir el archivo:", error);
    if (retries < maxRetries) {
      console.log(`Retrying upload for ${filePath} (attempt ${retries + 1} of ${maxRetries})`);
      await uploadFile(filePath, s3Key, retries + 1);
    } else {
      console.error(`Failed to upload ${filePath} after ${maxRetries} attempts`);
    }
  }
};

module.exports = {
  uploadFile,
}