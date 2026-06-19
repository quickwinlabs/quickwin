import { useState } from 'react'

function App() {
  const [count, setCount] = useState(0)
  return <w type="BUTTON" text={`Count: ${count}`} />
}
