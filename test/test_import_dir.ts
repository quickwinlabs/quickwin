import '../lib/fetch.js'
import * as os from 'os'

const parent = os.Worker.parent
parent.postMessage({ type: 'loaded' })
