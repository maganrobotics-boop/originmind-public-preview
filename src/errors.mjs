export class PublicError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "PublicError";
    this.status = status;
  }
}

export class ValidationError extends Error {
  constructor(message = "请检查输入内容、字数和必填项。") {
    super(message);
    this.name = "ValidationError";
  }
}
