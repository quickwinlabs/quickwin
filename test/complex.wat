(module
  (memory (export "memory") 1 256)
  (global (export "maxSize") i32 (i32.const 1024))
  (global (export "version") i32 (i32.const 2))

  (func $add (export "add") (param i32 i32) (result i32)
    local.get 0
    local.get 1
    i32.add
  )

  (func $sub (export "sub") (param i32 i32) (result i32)
    local.get 0
    local.get 1
    i32.sub
  )

  (func $mul (export "mul") (param i32 i32) (result i32)
    local.get 0
    local.get 1
    i32.mul
  )

  (func $factorial (export "factorial") (param i32) (result i32)
    (if (result i32) (i32.le_s (local.get 0) (i32.const 1))
      (then (i32.const 1))
      (else
        (i32.mul
          (local.get 0)
          (call $factorial (i32.sub (local.get 0) (i32.const 1)))
        )
      )
    )
  )
)
