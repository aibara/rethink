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

    test('publishes the cycle count from events that carry one, and not from door events', () => {
        const { ha, thinq } = makeDevice()
        const p = () => ha.devices[DEVICE_ID].properties
        thinq.emit('data', DOOR_OPEN)
        thinq.emit('data', PANEL_MENU)
        assert.equal(p().cycle_count, undefined)
        thinq.emit('data', COMPLETION) // 08 0b 01 0b 08 02 a2: the 674th cycle
        assert.equal(p().cycle_count, 674)
    })

    test('has no ezDispense entities, and publishes none of their values', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', EB_IDLE)
        const components = (ha.devices[DEVICE_ID].config as { components: Record<string, unknown> }).components
        const props = ha.devices[DEVICE_ID].properties
        for (const key of [
            'drawer',
            'ez_dispense_detergent',
            'ez_dispense_softener',
            'detergent_amount',
            'softener_amount',
            'softener_tank_use',
            'nozzle_clean_tank',
        ]) {
            assert.equal(components[key], undefined, key)
            assert.equal(props[key], undefined, key)
        }
        assert.ok(components.cycle_count)
        assert.ok(components.tub_clean_count)
    })
})

// From a WM5500HVA's capture, 2026-11-15: a Normal wash (Heavy soil, Hot, +1 rinse, TurboWash), 0xec records.
// Power-on: the first record carries 0 for the washes since the drum clean, the next the real 54.
const EC_POWER_ON_FIRST = buf(
    'aaff200a0074002d52000100ec00620000000e0000000000000000000000000000000000000000000000003604000000000000000000003800000000000004000005100e0f2e00000000000000008000800000002e0100060000000100040000000020000000000038000000000000040085f0bb',
)
const EC_POWER_ON_SECOND = buf(
    'aaff200a0074002d55000100ec00620005100e0f2e00000000000000008000800000002e010006000000010004000000002000000000003800000000000004000005100e0f2e00000000000000008000800000002e01000600000001360400000000200000000000380000000000000400e3a1bb',
)
// Running: Heavy, Hot, +1, High, TurboWash
const EC_RUNNING = buf(
    'aaff200a0074002da1000100ec00620005120f0f2e00000000000000008c008f0003002e0b0306050000023604000000002000001001403800000000000004000005120f0f2e00000000000000008b008f0004002e0b03060500000236040000000020000010014038000000000000040092eebb',
)
// Rinsing: soil cleared
const EC_RINSING = buf(
    'aaff200a00740032de000100ec00620005120f0f2e00000000000000002f008f0070002e0b0306050000023604000000002000001001403800000000000004000000120f0f2e00000000000000002e008f0071002e0c0b0605000002360400000000200000100140380000000000000400d3acbb',
)
// Rinsing: the extra rinse used up (+1 -> Normal)
const EC_RINSE_USED = buf(
    'aaff200a007400337e000100ec00620000120f0f2e000000000000000021008f0080002e0c0b06050000023604000000002000001001403800000000000004000000120e0f2e000000000000000020008f0083002e0c0b060500000136040000000020000010010038000000000000040011eabb',
)
// Spinning: temperature cleared
const EC_SPIN = buf(
    'aaff200a0074003446000100ec00620000120e0f2e000000000000000013008f0094002e0c0b06050000013604000000002000001001003800000000000004000000000e0f2e000000000000000012008f0097002e0e0c0605000000360400000000200000100100380000000000000400d019bb',
)
// End: spin and TurboWash cleared
const EC_END = buf(
    'aaff200a0074003582000100ec00620000000e0f2e000000000000000001008f00e4002e0e0c06050000003604000000002000001001003800000000000004000000000e002e000000000000000001000000e4002e100e0600000000360400000000000000000100380000000000000400e8ffbb',
)
// Off
const EC_OFF = buf(
    'aaff200a0074003590000100ec00620000000e002e000000000000000001000000e4002e100e06000000003704000000000000000000003800000000000004000000000e002e000000000000000001000000e4002e00100600000000370400000000000000000000380000000000000400a235bb',
)
// The 5-minute log (inner type 0x02): water temperature samples 22 22 22 41 44 as the hot fill comes in,
// then 41 40 40 40 39.
const LOG_FILLING = buf(
    'aaff200a0084002da60002010200490b010b6502a400021700040213021700000117181a1e21161616292cfffffcf1ef000000000000000000000000000000000000000000000000000000000000000000000000bd9a0b3d0105002546414658553232303237000000000000000000000102cb9483c406070000000000000000005f22bb',
)
const LOG_WASHING = buf(
    'aaff200a0084002dec0002010200490b010b6502a40003170009020e021700000221222624282928282827eff0f1eff0000000000000000000000000000000000000000000000000000000000000000000000000b8250b4f0105002546414658553232303237000000000000000000000102cc9483c40607000000000000000000cc6cbb',
)

// The end-of-cycle summary (inner type 0x04, id 03) from the same wash: 3 rinses, peak water 45 °C.
const SUMMARY = buf(
    'aaff200a005700358400010104004503010100040506073900000100ff01550000000003162d00022318010004fd78780000fdfd000000fd000002a75505000003000620250056740000422c36dd48858109091abf68bb',
)

// From a WM5500HVA's capture, 2026-11-17: a Tub Clean (84 min, spin Medium), whose heater took the drum to
// 66 °C. Its first log (water 21 21 21 24 27), the log with the peak (65 66 66 44 44, then drained), the
// completion notification and the summary, whose fill temperature is 20.
const TUB_LOG_FIRST = buf(
    'aaff200a00840088490002010200490b010b6502a500026900030119011d0000011317171919151515181bfffff8f3f3000000000000000000000000000000000000000000000000000000000000000000000000be0a00000105002546414658553232303237000000000000000000000102cd9483c406070000000000000000006468bb',
)
const TUB_LOG_PEAK = buf(
    'aaff200a0084008bb90002010200490b010b6502a500086900210038011d0000072a2a2a29294142422c2cf3f3f3eceb000000000000000007260000000000000000019f00000000000000000013000000000000b6500d3a0105002546414658553232303237000000000000000000000102ce9483c406070000000000000000004926bb',
)
const TUB_COMPLETION = buf(
    'aaff200a00b4008ec6000201030079080b010b0802a5003d6900540d0000000003000080236900000101005e06000305016b02600000eaff0100180047007f0075007100670003e803e801010048005502050154010601500004010101000002000002000004000106010205010104000103000103000000000000000000000000000000000103000105002546414658553232303237000000000000000000000102ce9483c40607000000000000000000d518bb',
)
const TUB_SUMMARY = buf(
    'aaff200a0057008ecb00010104004503010100040506073900000000ff01490000000001151408022916000001fd64640000fdfd000000fd000002a80005000003000d201500006a0002402c68bb40431a000109c6e3bb',
)

describe('FAFXU22027 cycle', () => {
    test('publishes the rinses, peak water temperature and top spin from the end-of-cycle summary', () => {
        const { ha, thinq } = makeDevice()
        const components = (ha.devices[DEVICE_ID].config as { components: Record<string, unknown> }).components
        assert.ok(components.rinse_count)
        assert.ok(components.peak_water_temp)
        assert.ok(components.top_spin)
        thinq.emit('data', SUMMARY)
        assert.equal(ha.devices[DEVICE_ID].properties.rinse_count, 3)
        assert.equal(ha.devices[DEVICE_ID].properties.peak_water_temp, 45)
        assert.equal(ha.devices[DEVICE_ID].properties.top_spin, 1200)
    })

    test("keeps the summary's fill temperature when the logs were cooler", () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', LOG_FILLING)
        thinq.emit('data', LOG_WASHING)
        thinq.emit('data', SUMMARY)
        assert.equal(ha.devices[DEVICE_ID].properties.peak_water_temp, 45)
    })

    test('takes the peak of a heated Tub Clean from the logs, with its length and spin', () => {
        const { ha, thinq } = makeDevice()
        const p = () => ha.devices[DEVICE_ID].properties
        assert.ok((ha.devices[DEVICE_ID].config as { components: Record<string, unknown> }).components.cycle_minutes)
        thinq.emit('data', TUB_LOG_FIRST)
        thinq.emit('data', TUB_LOG_PEAK)
        assert.equal(p().water_temp, 44)
        thinq.emit('data', TUB_COMPLETION)
        assert.equal(p().cycle_minutes, 84)
        thinq.emit('data', TUB_SUMMARY)
        assert.equal(p().rinse_count, 1)
        assert.equal(p().peak_water_temp, 66)
        assert.equal(p().top_spin, 1000)
    })

    test("starts each cycle's peak afresh", () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', TUB_LOG_PEAK)
        thinq.emit('data', TUB_LOG_FIRST)
        thinq.emit('data', TUB_SUMMARY)
        assert.equal(ha.devices[DEVICE_ID].properties.peak_water_temp, 27)
    })

    test('reads the length of a wash from its completion notification', () => {
        const { ha, thinq } = makeDevice()
        thinq.emit('data', COMPLETION)
        assert.equal(ha.devices[DEVICE_ID].properties.cycle_minutes, 37)
    })

    test('ignores a summary with an unknown prefix', () => {
        const { ha, thinq } = makeDevice()
        const bad = Buffer.from(SUMMARY)
        bad[13 + 2] = 0x02
        thinq.emit('data', bad)
        assert.equal(ha.devices[DEVICE_ID].properties.rinse_count, undefined)
    })

    test('skips the 0 washes-since-drum-clean in the first record after power-on', () => {
        const { ha, thinq } = makeDevice()
        const p = () => ha.devices[DEVICE_ID].properties
        thinq.emit('data', EC_OFF)
        assert.equal(p().tub_clean_count, 55)
        thinq.emit('data', EC_POWER_ON_FIRST)
        assert.equal(p().status, 'Initial')
        assert.equal(p().tub_clean_count, 55)
        thinq.emit('data', EC_POWER_ON_SECOND)
        assert.equal(p().tub_clean_count, 54)
    })

    test('keeps the settings the cycle runs with on show as the washer clears them', () => {
        const { ha, thinq } = makeDevice()
        const p = () => ha.devices[DEVICE_ID].properties
        const settings = () => [p().soil, p().temp, p().rinse, p().spin, p().turbo_wash]
        const running = ['Heavy', 'Hot', '+1', 'High', 'ON']
        thinq.emit('data', EC_RUNNING)
        assert.deepEqual(settings(), running)
        for (const frame of [EC_RINSING, EC_RINSE_USED, EC_SPIN, EC_END]) {
            thinq.emit('data', frame)
            assert.deepEqual(settings(), running, p().status as string)
        }
        assert.equal(p().status, 'End')
        thinq.emit('data', EC_OFF)
        assert.deepEqual(settings(), ['None', 'None', 'Normal', 'None', 'OFF'])
    })

    test('publishes the water temperature from the 5-minute log', () => {
        const { ha, thinq } = makeDevice()
        const components = (ha.devices[DEVICE_ID].config as { components: Record<string, unknown> }).components
        assert.ok(components.water_temp)
        thinq.emit('data', LOG_FILLING)
        assert.equal(ha.devices[DEVICE_ID].properties.water_temp, 44)
        thinq.emit('data', LOG_WASHING)
        assert.equal(ha.devices[DEVICE_ID].properties.water_temp, 39)
    })

    test('ignores a log whose trailing block has the wrong length', () => {
        const { ha, thinq } = makeDevice()
        const bad = Buffer.from(LOG_WASHING)
        bad[bad.length - 3 - 37 - 1] = 0x24
        thinq.emit('data', bad)
        assert.equal(ha.devices[DEVICE_ID].properties.water_temp, undefined)
    })
})
