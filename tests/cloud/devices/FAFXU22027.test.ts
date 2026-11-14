import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import DUT from '@/cloud/devices/FAFXU22027'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
const META: Metadata = { modelId: 'FAFXU22027', modelName: 'FAFXU22027', swVersion: '2.11.223' }

// Captured from a WM5500HVA: the reply to the status request at connect, powered on and idle with Normal
// on the dial. The record is 49 bytes (inner length 0x0031).
const EB_IDLE = buf(
    'aaff200a004300eb29000100eb00310005100e0f2e00000000000000008000800003002e01000600000001320400000000200000000000380000000000000400672abb',
)

// From a WM5500HVA's capture, 2026-11-14: spinning near the end of a Normal cycle (0xec, previous then
// current record).
const EC_SPINNING = buf(
    'aaff200a007400949e000100ec00620000000e0f2e00000000000000000300220037002e0e0c06030000003404000000002000001001003800000000000004000000000e0f2e0000000000000000020022003b002e0e0c06030000003404000000002000001001003800000000000004004360bb',
)

// Its events end with a block the WM6700HBA's don't send: 01 05 00 25, the model name, then 21 bytes.
// The completion notification, 30 ms before the record showing End:
const COMPLETION = buf(
    'aaff200a00b40094cd000201030079080b010b0802a20055280025060406000004008080a3690000030300d30600031e016c02720000eafa01001602fd050a05700ae40c280204b004b00101006c003b050901480417012e020702050c02051202051702031601041501051100050b000507010405010403010301010301010000000000000301010105002546414658553232303237000000000000000000000102cb9483c406070000000000000000001222bb',
)
// The door opening and shutting, and a panel-menu event (id 0x11) of the same length.
const DOOR_OPEN = buf(
    'aaff200a0041009212000201030006100b010b10010105002546414658553232303237000000000000000000000102ca9483c406070000000000000000002849bb',
)
const DOOR_SHUT = buf(
    'aaff200a004100920d000201030006100b010b10020105002546414658553232303237000000000000000000000102ca9483c4060700000000000000000062aebb',
)
const PANEL_MENU = buf(
    'aaff200a00410093d9000201030006110b010b11050105002546414658553232303237000000000000000000000102cc9483c4060700000000000000000097abbb',
)

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new DUT(ha.asConnection(), thinq, META)
    return { ha, thinq, dev }
}

describe('FAFXU22027', () => {
    test('decodes the 49-byte status record', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', EB_IDLE)
        const props = ha.devices[DEVICE_ID].properties
        assert.equal(props.status, 'Initial')
        assert.equal(props.course, 'Normal')
        assert.equal(props.tub_clean_count, 50)
        assert.equal(props.quick_load_sense, undefined)
    })

    test('has no QuickLoadSense entity, which its record lacks', () => {
        const { ha } = makeDevice()
        const components = (ha.devices[DEVICE_ID].config as { components: Record<string, unknown> }).components
        assert.ok(components.status)
        assert.equal(components.quick_load_sense, undefined)
    })

    test('reports the cycle finishing from its completion notification, block and all', (t) => {
        const { ha, thinq } = makeDevice()
        const publish = t.mock.method(ha, 'publishProperty')
        const finished = () => publish.mock.calls.filter((call) => call.arguments[1] === 'cycle_finished')
        thinq.emit('data', EC_SPINNING)
        thinq.emit('data', COMPLETION)
        assert.equal(finished().length, 1)
        assert.equal(finished()[0].arguments[2], JSON.stringify({ event_type: 'finished' }))
    })

    test('reports the door from its events, block and all', () => {
        const { ha, thinq } = makeDevice()
        const p = () => ha.devices[DEVICE_ID].properties
        thinq.emit('data', EB_IDLE)
        assert.equal(p().door, undefined)
        thinq.emit('data', DOOR_OPEN)
        assert.equal(p().door, 'ON')
        thinq.emit('data', PANEL_MENU)
        assert.equal(p().door, 'ON')
        thinq.emit('data', DOOR_SHUT)
        assert.equal(p().door, 'OFF')
    })

    test('ignores an event whose trailing block has the wrong length', () => {
        const { ha, thinq } = makeDevice()
        const bad = Buffer.from(DOOR_OPEN)
        bad[bad.length - 3 - 37 - 1] = 0x24 // the block's length byte: 0x25 -> 0x24
        thinq.emit('data', bad)
        assert.equal(ha.devices[DEVICE_ID].properties.door, undefined)
    })
})
