export function publicErrorMessage(error, fallback = "内部エラーが発生しました。時間を置いてもう一度お試しください。") {
  return error?.publicMessage || error?.safeMessage || fallback;
}

export function sendError(res, error, fallbackStatus = 400) {
  const statusCode = error?.statusCode || fallbackStatus;
  res.status(statusCode).json({
    error: publicErrorMessage(error)
  });
}

export function jsonError(message, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.publicMessage = message;
  return error;
}
