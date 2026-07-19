export {}

import {
    ReadableStream as ReadableStreamImpl,
    ReadableStreamDefaultController as ReadableStreamDefaultControllerImpl,
    ReadableStreamDefaultReader as ReadableStreamDefaultReaderImpl,
} from './vendor/web-streams/ponyfill.mjs'

declare global {
    type ReadableStreamReadResult<R = any> =
        | { done: false; value: R }
        | { done: true; value?: undefined }

    interface ReadableStreamReader<R = any> extends ReadableStreamDefaultReaderImpl<R> {}
    interface ReadableStreamDefaultReader<R = any> extends ReadableStreamDefaultReaderImpl<R> {}
    interface ReadableStream<R = any> extends ReadableStreamImpl<R> {}
    interface ReadableStreamDefaultController<R = any> extends ReadableStreamDefaultControllerImpl<R> {}

    var ReadableStream: typeof ReadableStreamImpl
}

globalThis.ReadableStream = ReadableStreamImpl