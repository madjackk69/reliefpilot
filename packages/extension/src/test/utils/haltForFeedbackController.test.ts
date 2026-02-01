import * as assert from 'assert'
import * as vscode from 'vscode'
import { HaltForFeedbackController } from '../../utils/haltForFeedbackController'

suite('HaltForFeedbackController', function () {
    this.timeout(10000)

    test('Initial state is running', () => {
        const c = new HaltForFeedbackController()
        assert.deepStrictEqual(c.getSnapshot(), { kind: 'running' })
        assert.strictEqual(c.isPaused(), false)
        assert.strictEqual(c.isDeclined(), false)
    })

    test('pause/resume transitions', () => {
        const c = new HaltForFeedbackController()
        c.pause('draft')
        assert.deepStrictEqual(c.getSnapshot(), { kind: 'paused', draftFeedback: 'draft' })
        assert.strictEqual(c.isPaused(), true)

        c.resume()
        assert.deepStrictEqual(c.getSnapshot(), { kind: 'running' })
        assert.strictEqual(c.isPaused(), false)
    })

    test('decline + takeDeclineAndReset', () => {
        const c = new HaltForFeedbackController()
        c.decline('feedback')
        assert.deepStrictEqual(c.getSnapshot(), { kind: 'declined', feedback: 'feedback' })

        const taken = c.takeDeclineAndReset()
        assert.strictEqual(taken, 'feedback')
        assert.deepStrictEqual(c.getSnapshot(), { kind: 'running' })

        const taken2 = c.takeDeclineAndReset()
        assert.strictEqual(taken2, undefined)
    })

    test('waitUntilNotPaused resolves on resume', async () => {
        const c = new HaltForFeedbackController()
        const cts = new vscode.CancellationTokenSource()
        c.pause('x')

        const p = c.waitUntilNotPaused(cts.token)
        // Resume shortly after
        c.resume()

        const snapshot = await p
        assert.deepStrictEqual(snapshot, { kind: 'running' })
    })

    test('Multiple waiters observe the same decline snapshot', async () => {
        const c = new HaltForFeedbackController()
        const cts = new vscode.CancellationTokenSource()
        c.pause('')

        const p1 = c.waitUntilNotPaused(cts.token)
        const p2 = c.waitUntilNotPaused(cts.token)

        c.decline('nope')

        const [s1, s2] = await Promise.all([p1, p2])
        assert.deepStrictEqual(s1, { kind: 'declined', feedback: 'nope' })
        assert.deepStrictEqual(s2, { kind: 'declined', feedback: 'nope' })
    })
})
