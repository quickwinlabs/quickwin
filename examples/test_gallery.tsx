import '../lib/polyfill.js'
import * as gui from 'gui'
import { useState } from 'react'
import {
  render, Button, Input, CheckBox, ProgressBar, ComboBox, Tab,
  ListView, type Column, ListBox, ScrollView, RadioButton, Slider,
  TreeView, type TreeNode, DateTimePicker, Link, Tooltip, PathPicker,
} from '../lib/react-qw/index.js'


gui.RegisterClass('Gallery', (hwnd, msg, wParam, lParam) => {
  if (!hwnd) return gui.DefWindowProc(hwnd, msg, wParam, lParam)
  if (msg === gui.WmMsg.DESTROY) {
    gui.PostQuitMessage(0)
    return 0
  }
  return gui.DefWindowProc(hwnd, msg, wParam, lParam)
})

const VISIBLE = gui.WindowStyle.VISIBLE
const CLIPCHILDREN = gui.WindowStyle.CLIPCHILDREN

interface Fruit {
  name: string
  color: string
  origin: string
}

const treeData: TreeNode[] = [
  {
    key: 'fruits', label: 'Fruits',
    children: [
      { key: 'apple', label: 'Apple' },
      { key: 'banana', label: 'Banana' },
      { key: 'cherry', label: 'Cherry' },
    ],
  },
  {
    key: 'veggies', label: 'Vegetables',
    children: [
      { key: 'carrot', label: 'Carrot' },
      { key: 'broccoli', label: 'Broccoli' },
    ],
  },
  {
    key: 'meats', label: 'Meats',
    children: [
      { key: 'chicken', label: 'Chicken' },
      { key: 'beef', label: 'Beef' },
      { key: 'pork', label: 'Pork' },
    ],
  },
]

function App({ svW, svH }: { svW: number; svH: number }) {
  const [count, setCount] = useState(0)
  const [disabled, setDisabled] = useState(true)
  const [inputText, setInputText] = useState('')
  const [checkA, setCheckA] = useState(true)
  const [checkB, setCheckB] = useState(false)
  const [progress, setProgress] = useState(30)
  const [lbSel, setLbSel] = useState(0)
  const [cbSel, setCbSel] = useState(-1)
  const [radio, setRadio] = useState('a')
  const [sliderVal, setSliderVal] = useState(50)
  const [treeSel, setTreeSel] = useState<TreeNode | null>(null)
  const [dtDate, setDtDate] = useState<Date | null>(new Date())
  const [pickerPath, setPickerPath] = useState('')
  const [listData, setListData] = useState<Fruit[]>([
    { name: 'Apple', color: 'Red', origin: 'China' },
    { name: 'Banana', color: 'Yellow', origin: 'Philippines' },
    { name: 'Cherry', color: 'Dark Red', origin: 'USA' },
    { name: 'Date', color: 'Brown', origin: 'Middle East' },
    { name: 'Elderberry', color: 'Purple', origin: 'Europe' },
    { name: 'Fig', color: 'Purple', origin: 'Turkey' },
    { name: 'Grape', color: 'Green', origin: 'Italy' },
  ])
  const [listCols, setListCols] = useState<Column<Fruit>[]>([
    { name: 'Name', dataIndex: 'name' },
    { name: 'Color', dataIndex: 'color' },
    { name: 'Origin', dataIndex: 'origin' },
  ])
  const lbItems = listData.map(f => f.name)
  const cbItems = ['Red', 'Green', 'Blue', 'Yellow', 'Purple', 'Orange']

  return (
      <ScrollView style={{width:svW, height:svH}} contentHeight={1600}>
      <w type="STATIC" ws={VISIBLE | CLIPCHILDREN | gui.WindowStyle.BORDER} style={{flexDirection:'column', gap:8, alignSelf:'stretch', flexGrow:1, padding:8}}>
      {/* ===== 三列上半区 ===== */}
      <w type="STATIC" ws={VISIBLE} style={{flexDirection:'row', gap:10, height:345}}>

        {/* --- 左列: Buttons + CheckBoxes --- */}
        <w type="STATIC" ws={VISIBLE | CLIPCHILDREN} style={{flexDirection:'column', gap:6, flexGrow:1}}>
          <w type="STATIC" ws={VISIBLE} text="Buttons" style={{height:24}} />
          <w type="STATIC" ws={VISIBLE} style={{flexDirection:'row', gap:6, alignItems:'stretch', height:30}}>
            <Tooltip text="Click to increment counter" balloon>
              <Button onClick={() => setCount(c => c + 1)} style={{flexGrow:1}}>
                {`Clicked ${count} times`}
              </Button>
            </Tooltip>
            <Button onClick={() => setCount(0)} style={{width:70}}>
              Reset
            </Button>
          </w>
          <w type="STATIC" ws={VISIBLE} style={{flexDirection:'row', gap:6, alignItems:'stretch', height:30}}>
            <Button onClick={() => setDisabled(d => !d)} style={{flexGrow:1}}>
              {`Toggle disabled (${String(disabled)})`}
            </Button>
            <Button disabled={disabled} style={{width:80}}>
              Disabled
            </Button>
          </w>
          <w type="STATIC" ws={VISIBLE} text="CheckBoxes" style={{height:24}} />
          <CheckBox checked={checkA} onChange={setCheckA} label={`Option A (${String(checkA)})`} style={{height:26}} />
          <CheckBox checked={checkB} onChange={setCheckB} label={`Option B (${String(checkB)})`} style={{height:26}} />
          <CheckBox label="Disabled checkbox" disabled style={{height:26}} />
          <w type="STATIC" ws={VISIBLE} text={`RadioButtons (${radio})`} style={{height:24}} />
          <RadioButton checked={radio === 'a'} onChange={() => setRadio('a')} label="Option A" style={{height:24}} />
          <RadioButton checked={radio === 'b'} onChange={() => setRadio('b')} label="Option B" style={{height:24}} />
          <RadioButton checked={radio === 'c'} onChange={() => setRadio('c')} label="Option C" style={{height:24}} />
        </w>

        {/* --- 中列: Input + ProgressBar --- */}
        <w type="STATIC" ws={VISIBLE | CLIPCHILDREN} style={{flexDirection:'column', gap:6, flexGrow:1}}>
          <w type="STATIC" ws={VISIBLE} text="Input" style={{height:24}} />
          <Input value={inputText} onChange={setInputText} placeholder="Type here..." style={{height:28}} />
          <Input placeholder="Password" password style={{height:28}} />
          <Input value="Read only" readonly style={{height:28}} />
          <w type="STATIC" ws={VISIBLE} text="ProgressBar" style={{height:24}} />
          <w type="STATIC" ws={VISIBLE} style={{flexDirection:'row', gap:6, alignItems:'stretch', height:24}}>
            <ProgressBar value={progress} max={100} smooth style={{flexGrow:1}} />
            <w type="STATIC" ws={VISIBLE} text={`${progress}%`} style={{width:40}} />
          </w>
          <w type="STATIC" ws={VISIBLE} style={{flexDirection:'row', gap:6, alignItems:'stretch', height:30}}>
            <Button onClick={() => setProgress(p => Math.min(100, p + 10))} style={{flexGrow:1}}>
              +10
            </Button>
            <Button onClick={() => setProgress(p => Math.max(0, p - 10))} style={{flexGrow:1}}>
              -10
            </Button>
            <Button onClick={() => setProgress(0)} style={{width:50}}>
              0
            </Button>
          </w>
          <w type="STATIC" ws={VISIBLE} text={`Slider (${sliderVal})`} style={{height:24}} />
          <Slider value={sliderVal} onChange={setSliderVal} min={0} max={100} style={{height:30}} />
        </w>

        {/* --- 右列: ListBox + ComboBox --- */}
        <w type="STATIC" ws={VISIBLE | CLIPCHILDREN} style={{flexDirection:'column', gap:6, flexGrow:1}}>
          <w type="STATIC" ws={VISIBLE} text={`ListBox (sel=${lbSel >= 0 ? lbItems[lbSel] : 'none'})`} style={{height:24}} />
          <ListBox items={lbItems} selectedIndex={lbSel} onChange={(i) => setLbSel(i)} style={{flexGrow:1}} />
          <w type="STATIC" ws={VISIBLE} text="ComboBox" style={{height:24}} />
          <ComboBox items={cbItems} selectedIndex={cbSel} onChange={(i) => setCbSel(i)} style={{height:26}} />
          <w type="STATIC" ws={VISIBLE}
            text={cbSel >= 0 ? `Selected: ${cbItems[cbSel]}` : '(none selected)'}
            style={{height:24}} />
        </w>
      </w>

      {/* ===== Auto-Size ===== */}
      <w type="STATIC" ws={VISIBLE} text="Auto-Size" style={{height:24}} />
      <w type="STATIC" ws={VISIBLE | CLIPCHILDREN | gui.WindowStyle.BORDER} style={{flexDirection:'column', gap:6, alignSelf:'stretch', flexGrow:1}}>
        <w type="STATIC" ws={VISIBLE} text="Buttons (auto width)" style={{height:24}} />
        <w type="STATIC" ws={VISIBLE} style={{flexDirection:'row', gap:8, alignItems:'stretch', height:30}}>
          <Button style={{width:'auto', height:30}}>OK</Button>
          <Button style={{width:'auto', height:30}}>Cancel</Button>
          <Button style={{width:'auto', height:30}}>A very long button text</Button>
        </w>
        <w type="STATIC" ws={VISIBLE} text="Statics (auto width)" style={{height:24}} />
        <w type="STATIC" ws={VISIBLE} style={{flexDirection:'row', gap:8, alignItems:'stretch', height:24}}>
          <w type="STATIC" ws={VISIBLE | gui.WindowStyle.BORDER} text="Short" style={{width:'auto', height:24}} />
          <w type="STATIC" ws={VISIBLE | gui.WindowStyle.BORDER} text="A much longer label" style={{width:'auto', height:24}} />
        </w>
        <w type="STATIC" ws={VISIBLE} text="Mixed auto + fixed" style={{height:24}} />
        <w type="STATIC" ws={VISIBLE} style={{flexDirection:'row', gap:8, alignItems:'stretch', height:30}}>
          <Button style={{width:150, height:30}}>Fixed 150</Button>
          <Button style={{width:'auto', height:30}}>Auto</Button>
        </w>
      </w>

      {/* ===== Tab Demo ===== */}
      <w type="STATIC" ws={VISIBLE} text="Tab" style={{height:24}} />
      <Tab
        tabs={[
          { title: 'Counter', content: (
            <w type="STATIC" ws={VISIBLE | CLIPCHILDREN} style={{flexDirection:'column', gap:6}}>
              <w type="STATIC" ws={VISIBLE} text={`Count: ${count}`} style={{height:24}} />
              <Button onClick={() => setCount(c => c + 1)} style={{width:80}}>+1</Button>
            </w>
          )},
          { title: 'Typing', content: (
            <w type="STATIC" ws={VISIBLE | CLIPCHILDREN} style={{flexDirection:'column', gap:6}}>
              <Input value={inputText} onChange={setInputText} placeholder="Type here..." style={{height:28}} />
              <w type="STATIC" ws={VISIBLE} text={inputText ? `You typed: ${inputText}` : '(empty)'} style={{height:24}} />
            </w>
          )},
        ]}
        style={{height:120}}
      />

      {/* ===== DateTimePicker ===== */}
      <w type="STATIC" ws={VISIBLE} text={`DateTimePicker (${dtDate ? `${dtDate.getFullYear()}-${String(dtDate.getMonth()+1).padStart(2,'0')}-${String(dtDate.getDate()).padStart(2,'0')}` : 'none'})`} style={{height:24}} />
      <w type="STATIC" ws={VISIBLE} style={{flexDirection:'row', gap:8, alignItems:'stretch', height:28}}>
        <DateTimePicker value={dtDate} onChange={setDtDate} style={{flexGrow:1}} />
        <DateTimePicker value={dtDate} onChange={setDtDate} format="long" style={{flexGrow:1}} />
        <DateTimePicker value={dtDate} onChange={setDtDate} format="time" style={{flexGrow:1}} />
      </w>

      {/* ===== SysLink ===== */}
      <w type="STATIC" ws={VISIBLE} text="SysLink" style={{height:24}} />
      <w type="STATIC" ws={VISIBLE} style={{flexDirection:'row', gap:8, alignItems:'stretch', height:28}}>
        <Link href="https://example.com" onClick={(url) => console.log('Link clicked:', url)} style={{flexGrow:1}}>
          Example Link
        </Link>
        <Link href="https://github.com" onClick={(url) => console.log('Link clicked:', url)} style={{flexGrow:1}} />
      </w>

      {/* ===== PathPicker ===== */}
      <w type="STATIC" ws={VISIBLE} text="PathPicker" style={{height:24}} />
      <w type="STATIC" ws={VISIBLE} style={{flexDirection:'column', gap:6, height:130}}>
        <PathPicker type="file" title="Select a file" style={{height:28}} />
        <PathPicker type="folder" title="Select a folder" style={{height:28}} />
        <PathPicker type="file" value={pickerPath} onChange={setPickerPath} title="Controlled" style={{height:28}} />
        <w type="STATIC" ws={VISIBLE} text={pickerPath ? `Selected: ${pickerPath}` : '(none)'} style={{height:20}} />
      </w>

      {/* ===== 下半区: ListView + ScrollView + TreeView ===== */}
      <w type="STATIC" ws={VISIBLE} style={{flexDirection:'row', gap:6, alignItems:'stretch', height:400}}>
        <w type="STATIC" ws={VISIBLE | CLIPCHILDREN} style={{flexDirection:'column', gap:4, flexGrow:1}}>
          <w type="STATIC" ws={VISIBLE} text={`ListView (${listData.length} items)`} style={{height:24}} />
          <w type="STATIC" ws={VISIBLE} style={{flexDirection:'row', gap:6, alignItems:'stretch', flexGrow:1}}>
            <ListView<Fruit>
              columns={listCols}
              data={listData}
              style={{flexGrow:1}}
            />
            <w type="STATIC" ws={VISIBLE | CLIPCHILDREN} style={{flexDirection:'column', gap:6, width:100}}>
              <Button onClick={() => setListData(d => [...d, { name: 'NewItem ' + String(listData.length + 1), color: '', origin: '' }])} style={{height:28}}>
                Add
              </Button>
              <Button onClick={() => setListCols(cols => [...cols, { name: 'Col' + (listCols.length + 1), dataIndex: 'name' as keyof Fruit }])} style={{height:28}}>
                +Column
              </Button>
            </w>
          </w>
        </w>
        <w type="STATIC" ws={VISIBLE | CLIPCHILDREN} style={{flexDirection:'column', gap:4, flexGrow:1}}>
          <w type="STATIC" ws={VISIBLE} text="ScrollView (scrollable)" style={{height:24}} />
          <ScrollView style={{flexGrow:1}} contentWidth={500} contentHeight={560}>
            {Array.from({ length: 20 }, (_, i) => (
              <w type="STATIC" ws={VISIBLE}
                key={i}
                text={`Item ${i + 1} - ${i === 0 ? 'here is a line so wide that the horizontal scrollbar appears for demonstration' : ''}`}
                style={{width: i === 0 ? 500 : 200, height:28}}
              />
            ))}
          </ScrollView>
        </w>
        <w type="STATIC" ws={VISIBLE | CLIPCHILDREN} style={{flexDirection:'column', gap:4, flexGrow:1}}>
          <w type="STATIC" ws={VISIBLE} text={`TreeView (sel=${treeSel?.label ?? 'none'})`} style={{height:24}} />
          <TreeView data={treeData} onSelect={setTreeSel} style={{flexGrow:1}} />
        </w>
      </w>
      </w>
    </ScrollView>
  )
}

const hwnd = gui.CreateWindow(
  'Gallery', 'Component Gallery',
  gui.WindowStyle.OVERLAPPEDWINDOW,
  100, 100, 1400, 1200, null, null
)

if (hwnd) {
  const cr = gui.GetClientRect(hwnd)!
  const scale = gui.GetScaleFactor()
  const svW = Math.round((cr.right - cr.left) / scale)
  const svH = Math.round((cr.bottom - cr.top) / scale)
  render(<App svW={svW} svH={svH} />, hwnd)
  setTimeout(() => {
    gui.ShowWindow(hwnd)
  }, 0)
}
