(module
  (import "env" "log" (func $log (param i32)))
  (import "env" "add" (func $add (param i32 i32) (result i32)))
  (func (export "run") (param i32) (result i32)
    local.get 0
    i32.const 2
    call $add
    local.tee 0
    call $log
    local.get 0
  )
)
