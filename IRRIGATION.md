# Irrigation Blueprints

The irrigation system consists of two cooperating Home Assistant blueprints:

- [Irrigation Zone Calculation](blueprints/automation/irrigation_zone_calculation.yaml) calculates one zone's total watering demand.
- [Irrigation Scheduler](blueprints/automation/irrigation_scheduler.yaml) turns the demands of all zones into sequential valve runs.

## Setup

1. Under **Settings > Devices & services > Helpers**, create one dedicated **Text** helper per zone and set its maximum length to **255** characters.
2. Create one **Irrigation Zone Calculation** automation per valve. Assign a different helper to every zone; do not edit or reuse these helpers manually.
3. Select a History Statistics sensor for rain duration and a sensor reporting the maximum temperature of the last 24 hours. The rain sensor must report the percentage of the last 24 hours during which rain was detected, not precipitation in millimetres. Temperature must be in degrees Celsius.
4. Optionally select a soil-moisture sensor reporting 0–100% and configure its target value.
5. Create one **Irrigation Scheduler** automation. Select every zone helper exactly once and arrange them in the desired watering order. Zones run one at a time.
6. Configure the primary daily start time and, if limited runs may need another opportunity, an additional daily start time. A time earlier than the primary time means the following morning.

## How Zones are Scheduled

1. Before the first primary daily start time of its planning cycle, each zone calculates its [**total watering demand**](#total-watering-demand-calculation) for the entire cycle in minutes.
2. The scheduler then attempts to satisfy the total watering demand per zone as quickly as possible, starting at the first **primary daily start time**. It schedules all zones with remaining watering demand sequentially in their configured order.
3. If an optional **maximum duration per run** was configured for a zone, the scheduler does not exceed this duration. Any leftover demand is carried over to subsequent daily start times, or even following days, until either the zone's total watering demand has been satisfied, or a new planning cycle begins.
4. Right before every subsequent daily start time, the system checks rainfall and soil moisture again. Additional rainfall or increased soil moisture may reduce the remaining demand.
5. Changes to the calculated watering demand, watering activity and problems are logged at the individual valve entities.

## Total Watering Demand Calculation

Each zone calculates its total watering demand like this:

- Calculation starts with the zone's configured **reference runtime** in minutes.
- It can then be increased due to high temperatures and/or dry soil.
- It can also be reduced due to low temperatures and/or rain.
- The result is then rounded up to whole minutes.

### Temperature

The maximum temperature of the last 24 hours produces this factor:

| Maximum temperature | Factor applied to reference runtime |
| ---: | ---: |
| Below 12 °C | 0% |
| 12–25 °C | 70% |
| Above 25 °C and below 35 °C | Linear increase from 70% to 200% |
| 35 °C or higher | 200% |

The factor is rounded to two decimal places. An unavailable temperature sensor falls back to 20 °C and therefore 70%.

### Soil moisture

Soil moisture can only add demand. Moisture at or above the target adds nothing. Every percentage point below the target adds 5%, up to a maximum increase of 100% at a deficit of 20 percentage points.

```text
soil factor = 1 + min(1, moisture deficit / 20)
```

If no soil sensor is configured, no soil adjustment is applied. The same is true if no valid reading is available when demand is first calculated. Before later daily start times, an unavailable reading is ignored and has no effect on watering demand.

### Rain

The rain sensor reports the percentage of the last 24 hours during which rain was detected. Detected rain duration rounds up; the configured credited share then rounds down.

```text
detected rain minutes = ceil(24 × 60 × rain percentage / 100)
credited rain minutes = floor(detected rain minutes × rain credit percentage / 100)
```

An unavailable rain sensor is treated as 0%.

### Final demand

The temperature and soil factors are multiplied and rounded to two decimal places before the result is rounded up to a whole minute. Credited rain is subtracted last, without allowing demand to become negative.

```text
gross demand = ceil(reference runtime × round(temperature factor × soil factor, 2))
watering demand = max(0, gross demand - credited rain minutes)
```

For example:

```text
30 minutes reference runtime
+ 30 minutes due to heat
+ 45 minutes due to dry soil
- 13 minutes of credited rain
= 92 minutes watering demand
```

## Additional Scheduling Details

If the additional daily start time is earlier than the primary daily start time, it means the following morning. For example, primary `21:00` and additional `06:00` produce `21:00`, `06:00 next day`, and then `21:00 next day`.

Demand that cannot be delivered before the next planning cycle expires. The new cycle starts with a fresh calculation and no delivered minutes carried over.

Once a run starts, its planned end does not change. A recalculation affects only demand remaining after that run.

When a master pump is configured, it starts 10 seconds before the first valve, remains on during direct handovers, and stops when no scheduled zone remains. Competing valves are closed before a new zone starts.

For 30 minutes after a scheduled run or recorded completion, the scheduler cleans up a valve or pump left on. Outside that period it leaves devices alone so it does not interfere with unrelated manual control.
