class HttpError extends Error {
  constructor(statusCode, message, details = null) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.httpStatus = statusCode;
    this.details = details;
  }
}

export { HttpError };
