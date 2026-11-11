import { Device as Thinq2Device } from '../thinq2/device'
import { type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import FAFXU22007 from './FAFXU22007'

// LG WM5500HVA front-load washer. Its frames, acks and record layout match the WM6700HBA's (FAFXU22007),
// but its status record is 49 bytes rather than 51: it stops before OPT7, which holds QuickLoadSense.
// Status decoding has been checked against the appliance; writes have not.
const RECORD_LEN = 49

export default class Device extends FAFXU22007 {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, meta, RECORD_LEN)
    }
}
