import * as os from 'os'

const parent = os.Worker.parent
parent.postMessage({ type: 'url', url: import.meta.url })
