import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import WMVEM1825 from './WMVEM1825'

// The appliance sends its door-open event only while idle. Opening the door during a cook sends a
// pause event instead, with this payload byte set; a pause from the Stop key leaves it clear. The
// door-closed event always follows, so the door state recovers. Opening the door after a cook has
// finished is not reported at all: it clears Done exactly like the Stop key does.
const PAUSE_EVENT = Buffer.from('41b20007', 'hex')
const PAUSE_DOOR_OPEN_OFFSET = 5 + 23

// After every cook, repeated every 5 s for about half a minute: the energy the cook used, in Wh, twice.
//
//     41 3e 00 54 00 54 00
//           └─┬─┘ └─┬─┘
//             └ Wh  └ again
//
// Matches 1.62-1.68 kW times the cook time on all eleven captured cooks (27 Wh for 1:00, 84 Wh for 3:00).
const COOK_ENERGY = Buffer.from('413e', 'hex')
const COOK_ENERGY_LEN = 7

// After every cook, twice: a 126-byte summary event. Bytes 74-75 count cooks over the appliance's life; they
// went up by exactly one on each of the eleven captured cooks (866 to 874). Byte 72 repeats the cook's energy
// (cleared in the second copy).
const COOK_SUMMARY = Buffer.from('41b200047e', 'hex')
const COOK_SUMMARY_MARK = Buffer.from('02020000', 'hex')
const COOK_SUMMARY_MARK_OFFSET = 67
const COOK_COUNT_OFFSET = 74

// At every connect: an 81-byte info event with the part number, "WMHES1738" and the firmware date, then the
// appliance's clock, 12-hour, as hours, minutes, seconds after 43 19 00 41. On fourteen connects it was within
// 2 s of local time (the clock is synced from HA daily).
const INFO_EVENT = Buffer.from('41b2000b51', 'hex')
const INFO_MODEL = Buffer.from('WMHES1738', 'ascii')
const INFO_MODEL_OFFSET = 26
const INFO_CLOCK_MARK = Buffer.from('43190041', 'hex')
const INFO_CLOCK_OFFSET = 58

// LG MHES1738F over-the-range microwave. Status records, door events and hood commands match the
// MVEM1825, but the vent fan has five speeds instead of two.
export default class Device extends WMVEM1825 {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, meta, 5, {
            cook_energy: {
                platform: 'sensor',
                unique_id: '$deviceid-cook_energy',
                state_topic: '$this/cook_energy',
                name: 'Last cook energy',
                icon: 'mdi:lightning-bolt',
                device_class: 'energy',
                unit_of_measurement: 'Wh',
            },
            clock: {
                platform: 'sensor',
                unique_id: '$deviceid-clock',
                state_topic: '$this/clock',
                name: 'Clock at connect',
                icon: 'mdi:clock-outline',
                entity_category: 'diagnostic',
            },
            cook_count: {
                platform: 'sensor',
                unique_id: '$deviceid-cook_count',
                state_topic: '$this/cook_count',
                name: 'Cooks',
                icon: 'mdi:counter',
                state_class: 'total_increasing',
                entity_category: 'diagnostic',
            },
        })
    }

    processAABB(buf: Buffer) {
        if (
            buf.length === COOK_ENERGY_LEN &&
            buf.subarray(0, 2).equals(COOK_ENERGY) &&
            buf.readUInt16BE(2) === buf.readUInt16BE(4)
        ) {
            this.publishProperty('cook_energy', buf.readUInt16BE(2))
            return
        }
        if (
            buf.length === 5 + buf[4] &&
            buf.subarray(0, 5).equals(COOK_SUMMARY) &&
            buf.subarray(COOK_SUMMARY_MARK_OFFSET, COOK_SUMMARY_MARK_OFFSET + 4).equals(COOK_SUMMARY_MARK)
        ) {
            this.publishProperty('cook_count', buf.readUInt16BE(COOK_COUNT_OFFSET))
            return
        }
        if (
            buf.length === 5 + buf[4] &&
            buf.subarray(0, 5).equals(INFO_EVENT) &&
            buf.subarray(INFO_MODEL_OFFSET, INFO_MODEL_OFFSET + INFO_MODEL.length).equals(INFO_MODEL) &&
            buf.subarray(INFO_CLOCK_OFFSET - 4, INFO_CLOCK_OFFSET).equals(INFO_CLOCK_MARK)
        ) {
            const [h, m, sec] = buf.subarray(INFO_CLOCK_OFFSET, INFO_CLOCK_OFFSET + 3)
            if (h <= 12 && m < 60 && sec < 60)
                this.publishProperty('clock', `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`)
            return
        }
        if (buf.length === 5 + buf[4] && buf.subarray(0, 4).equals(PAUSE_EVENT) && buf[PAUSE_DOOR_OPEN_OFFSET] === 1) {
            this.publishProperty('door', 'ON')
            return
        }
        super.processAABB(buf)
    }
}
