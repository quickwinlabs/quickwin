import * as os from 'os'

// Use variable to bypass compiler's static module resolution
const url = 'https://esm.sh/' + 'isarray'
const { default: isArray } = await import(url)

const parent = os.Worker.parent

parent.onmessage = (e) => {
    const d = e.data as { type: string; [key: string]: unknown }
    if (d.type === 'start') {
        parent.postMessage({
            type: 'result',
            isArrayWorks: isArray([]) === true,
            isArrayRejects: isArray({}) === false,
        })
    } else if (d.type === 'done') {
        parent.onmessage = null
    }
}
