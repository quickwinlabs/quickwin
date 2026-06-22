import * as os from 'os'

// Use variable to bypass compiler's static module resolution
const url = 'https://esm.sh/' + 'isarray'
const { default: isArray } = await import(url)

const parent = os.Worker.parent

parent.onmessage = (e) => {
    if (e.data.type === 'start') {
        parent.postMessage({
            type: 'result',
            isArrayWorks: isArray([]) === true,
            isArrayRejects: isArray({}) === false,
        })
    } else if (e.data.type === 'done') {
        parent.onmessage = null
    }
}
