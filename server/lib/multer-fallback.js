"use strict";

function createError(status, message) {
  const error = new Error(String(message || "Upload error"));
  error.status = Number(status) || 500;
  return error;
}

function getBoundary(contentType) {
  const raw = String(contentType || "");
  const match = raw.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  return String(match?.[1] || match?.[2] || "").trim();
}

function parseContentDisposition(headerValue) {
  const raw = String(headerValue || "");
  const parts = raw.split(";").map((part) => part.trim()).filter(Boolean);
  const out = {};
  for (const part of parts.slice(1)) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    let value = part.slice(eq + 1).trim();
    if (value.startsWith("\"") && value.endsWith("\"")) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

function parseMultipart(buffer, boundary) {
  const files = [];
  const body = {};
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  let cursor = buffer.indexOf(boundaryBuffer);

  while (cursor !== -1) {
    let partStart = cursor + boundaryBuffer.length;
    const tail = buffer.slice(partStart, partStart + 2).toString("latin1");
    if (tail === "--") break;
    if (tail === "\r\n") partStart += 2;

    const nextBoundary = buffer.indexOf(boundaryBuffer, partStart);
    if (nextBoundary === -1) break;

    let partEnd = nextBoundary;
    if (buffer.slice(partEnd - 2, partEnd).toString("latin1") === "\r\n") {
      partEnd -= 2;
    }

    const part = buffer.slice(partStart, partEnd);
    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd === -1) {
      cursor = nextBoundary;
      continue;
    }

    const headerText = part.slice(0, headerEnd).toString("utf8");
    const content = part.slice(headerEnd + 4);
    const headers = {};
    for (const line of headerText.split("\r\n")) {
      const idx = line.indexOf(":");
      if (idx <= 0) continue;
      headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
    }

    const disposition = parseContentDisposition(headers["content-disposition"]);
    const fieldName = String(disposition.name || "").trim();
    if (!fieldName) {
      cursor = nextBoundary;
      continue;
    }

    const fileName = String(disposition.filename || "").trim();
    if (fileName) {
      files.push({
        fieldname: fieldName,
        originalname: fileName,
        encoding: "7bit",
        mimetype: String(headers["content-type"] || "application/octet-stream"),
        size: content.length,
        buffer: content,
      });
    } else {
      body[fieldName] = content.toString("utf8");
    }

    cursor = nextBoundary;
  }

  return { files, body };
}

function multer(options = {}) {
  const limits = options?.limits || {};
  const maxFiles = Number.isFinite(limits.files) ? limits.files : Infinity;
  const maxFileSize = Number.isFinite(limits.fileSize) ? limits.fileSize : Infinity;
  const maxBodySize = Number.isFinite(limits.fieldSize)
    ? Math.max(limits.fieldSize, maxFileSize * Math.max(maxFiles, 1))
    : maxFileSize * Math.max(maxFiles, 1) + 1024 * 1024;

  return {
    array(fieldName, requestedMaxCount) {
      const allowedCount = Math.min(
        Number.isFinite(requestedMaxCount) ? requestedMaxCount : maxFiles,
        maxFiles
      );

      return function multerFallbackArray(req, res, next) {
        const method = String(req.method || "").toUpperCase();
        if (method !== "POST" && method !== "PUT" && method !== "PATCH") return next();

        const contentType = String(req.headers["content-type"] || "");
        if (!contentType.toLowerCase().startsWith("multipart/form-data")) {
          req.files = [];
          return next();
        }

        const boundary = getBoundary(contentType);
        if (!boundary) return next(createError(400, "Missing multipart boundary."));

        const chunks = [];
        let totalSize = 0;

        req.on("data", (chunk) => {
          totalSize += chunk.length;
          if (totalSize > maxBodySize) {
            req.destroy(createError(413, "Uploaded payload is too large."));
            return;
          }
          chunks.push(chunk);
        });

        req.on("end", () => {
          try {
            const { files, body } = parseMultipart(Buffer.concat(chunks), boundary);
            const matchingFiles = files.filter((file) => file.fieldname === fieldName);

            if (matchingFiles.length > allowedCount) {
              return next(createError(413, "Too many files uploaded."));
            }
            for (const file of matchingFiles) {
              if (file.size > maxFileSize) {
                return next(createError(413, "Uploaded file is too large."));
              }
            }

            req.body = Object.assign({}, req.body || {}, body);
            req.files = matchingFiles;
            return next();
          } catch (error) {
            return next(error);
          }
        });

        req.on("error", (error) => next(error));
      };
    },
  };
}

multer.memoryStorage = function memoryStorage() {
  return {
    _fallback: true,
  };
};

module.exports = multer;
