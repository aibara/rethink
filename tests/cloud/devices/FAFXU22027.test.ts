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
})
