import { Tester } from './test_helper.js'

export const suite = {
    name: 'basic',
    run: (t: Tester) => {
        t.section('smoke')
        t.check('hello', true, true)
    }
}
