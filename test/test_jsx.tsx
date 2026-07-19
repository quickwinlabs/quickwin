import { useState } from 'react'

function App() {
  const [count] = useState(0)
  return <w type="BUTTON" text={`Count: ${count}`} />
}

export default App
