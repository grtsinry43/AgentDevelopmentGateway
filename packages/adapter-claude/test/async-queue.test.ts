import assert from 'node:assert/strict'
import test from 'node:test'
import { AsyncQueue } from '../src/async-queue.js'

test('delivers buffered and pending values in order before closing', async () => {
  const queue = new AsyncQueue<number>()
  const iterator = queue[Symbol.asyncIterator]()
  queue.push(1)
  assert.deepEqual(await iterator.next(), { value: 1, done: false })

  const pending = iterator.next()
  queue.push(2)
  assert.deepEqual(await pending, { value: 2, done: false })

  queue.close()
  assert.deepEqual(await iterator.next(), { value: undefined, done: true })
  assert.throws(() => queue.push(3), /closed async queue/)
})

test('propagates failure and rejects a second consumer', async () => {
  const queue = new AsyncQueue<number>()
  const iterator = queue[Symbol.asyncIterator]()
  assert.throws(() => queue[Symbol.asyncIterator](), /one consumer/)

  const pending = iterator.next()
  queue.fail(new Error('queue failed'))
  await assert.rejects(pending, /queue failed/)
})
