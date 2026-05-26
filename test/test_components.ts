import { Tester } from './test_helper.js'
import * as gui from 'gui'
import * as std from 'std'
import { createElement } from '../lib/preact/preact.js'
import { render } from '../lib/preact/render.js'
import { Button } from '../lib/preact/components/Button.js'
import { EditBox } from '../lib/preact/components/EditBox.js'

export const suite = {
    name: 'components',
    run: async (t: Tester) => {

        const parent = gui.CreateWindow('STATIC', '', 0, 0, 0, 200, 200, null, null)
        if (!parent) { std.printf('SKIP: cannot create window\n'); return }

        t.section('Button renders')
        const btn = createElement(Button, { text: 'Click' })
        const btnHwnd = render(btn, parent)
        t.checkTrue('returned hwnd is truthy', btnHwnd !== null && btnHwnd !== 0)

        t.section('EditBox renders')
        const edit = createElement(EditBox, { value: 'hello' })
        const editHwnd = render(edit, parent)
        t.checkTrue('returned hwnd is truthy', editHwnd !== null && editHwnd !== 0)

        t.section('EditBox with password style')
        const pw = createElement(EditBox, { password: true })
        const pwHwnd = render(pw, parent)
        t.checkTrue('returned hwnd is truthy', pwHwnd !== null && pwHwnd !== 0)

        t.section('EditBox with multiline')
        const ml = createElement(EditBox, { multiline: true, value: 'line1\nline2' })
        const mlHwnd = render(ml, parent)
        t.checkTrue('returned hwnd is truthy', mlHwnd !== null && mlHwnd !== 0)

        t.section('EditBox with placeholder')
        const ph = createElement(EditBox, { placeholder: 'Enter text' })
        const phHwnd = render(ph, parent)
        t.checkTrue('returned hwnd is truthy', phHwnd !== null && phHwnd !== 0)

        t.section('Button default style')
        const defBtn = createElement(Button, { text: 'OK', default: true })
        const defHwnd = render(defBtn, parent)
        t.checkTrue('returned hwnd is truthy', defHwnd !== null && defHwnd !== 0)

        gui.RemoveWindow(parent)
        gui.DestroyWindow(parent)
    }
}
