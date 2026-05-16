(module
  (import "env" "imported_add" (func $imported_add (param i32 i32) (result i32)))
  (func (export "add_via_import") (param i32 i32) (result i32)
    local.get 0
    local.get 1
    call $imported_add
  )
)
