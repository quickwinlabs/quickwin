import '../lib/polyfill.js'
import * as std from 'std'
import * as gui from 'gui'
import React from 'react'
import { createRoot, ListView, makeColorBlock, type Column } from '../lib/react-qw/index.js'

let clicks = 0

interface Row {
  name: string
  action: string
  size: string
}

const data: Row[] = [
  { name: 'README.md', action: '编辑', size: '120' },
  { name: 'package.json', action: '查看', size: '340' },
  { name: 'AGENTS.md', action: '下载', size: '890' },
]

const icons = [
  makeColorBlock(32, 0x000000FF),
  makeColorBlock(32, 0x0000FF00),
  makeColorBlock(32, 0x00FF0000),
]

const columns: Column<Row>[] = [
  {
    name: '文件',
    dataIndex: 'name',
    cellStyle: (_record, index) => (index % 2 === 0 ? { background: 0x00F0F0F0 } : {}),
  },
  {
    name: '大小',
    dataIndex: 'size',
    width: 90,
    align: 'right',
  },
  {
    name: '操作',
    dataIndex: 'action',
    align: 'center',
    cellStyle: { color: 0x00FF0000, underline: true, cursor: gui.StandardCursor.CROSS },
    onCellClick: (record, row) => {
      clicks++
      console.log(`link clicked row=${row} name=${record.name} clicks=${clicks}`)
      setTitle(`已点击 ${record.name}（第 ${clicks} 次）`)
    },
  },
]

let setTitle: (s: string) => void = () => {}

function App() {
  const [title, set] = React.useState('点击右侧操作列试试')
  setTitle = set
  return (
    <w type="STATIC" style={{ flexGrow: 1, flexDirection: 'column', alignItems: 'stretch', padding: 10 }}>
      <w type="STATIC" text={title} style={{ height: 28 }} />
      <ListView<Row>
        columns={columns}
        data={data}
        icons={icons}
        getIcon={(record) => (record.name === 'README.md' ? 0 : record.name === 'package.json' ? 1 : 2)}
        style={{ flexGrow: 1 }}
      />
    </w>
  )
}

createRoot({
  text: 'ListView cell style test', width: 420, height: 260,
  onEvent: (e) => {
    if (e.msg === gui.WmMsg.CLOSE) {
      console.log('test_react_listview_link done clicks=' + clicks)
      std.exit(0)
    }
  }
}).render(<App />)
