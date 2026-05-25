import { Tester } from './test_helper.js'
import * as gui from 'gui'
import * as std from 'std'
import { createElement, createRef } from '../lib/preact/preact.js'
import { render } from '../lib/preact/render.js'

export const suite = {
    name: 'preact-ref',
    run: async (t: Tester) => {

        const parentHwnd = gui.CreateWindow('STATIC', '', 0, 0, 0, 100, 100, null, null)
        if (!parentHwnd) { std.printf('SKIP: cannot create window\n'); return }

        t.section('object ref')
        const myRef = createRef()
        const vnode = createElement('w', { type: 'static', ref: myRef })
        render(vnode, parentHwnd)
        t.checkTrue('ref.current is truthy', myRef.current !== null && myRef.current !== 0)

        t.section('callback ref')
        let captured = 0
        const cbRef = (hwnd: any) => { captured = hwnd }
        const vnode2 = createElement('w', { type: 'static', ref: cbRef } as any)
        render(vnode2, parentHwnd)
        t.checkTrue('callback captured hwnd', captured !== 0)

        gui.RemoveWindow(parentHwnd)
        gui.DestroyWindow(parentHwnd)
    }
}
