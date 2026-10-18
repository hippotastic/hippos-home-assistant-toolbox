# Time-Based Exponential Moving Average

**What is this?** An automation blueprint that turns a fluctuating numeric sensor reading into a smoother value for dashboards and automations. Once per minute, it moves a Number helper's value toward the current reading, so brief spikes have less influence than lasting changes. If the sensor is unavailable, it keeps the last average.

**When should you use this?** When you want your lights or covers to follow changes in daylight, but short brightness spikes keep triggering adjustments.

**Why is this included in the toolbox?** Home Assistant's [Filter helper](https://www.home-assistant.io/integrations/filter/) already offers exponential smoothing with `lowpass` and a time-based simple moving average with `time_simple_moving_average`. Both recalculate in response to source-entity updates, rather than on a regular timer. The time-based filter's window describes the history to average, not how often to update the result. If the source stops updating, the filtered value can remain different from the latest reading indefinitely. This blueprint fills that gap for exponential smoothing: it samples the latest reading once per minute, so the average keeps approaching it even without another source update.

## Before you start

Install the [toolbox integration](../README.md#installation) or import the [blueprint](../blueprints/automation/exponential_moving_average.yaml) manually. You need a numeric sensor and a dedicated `input_number` helper for the result.

## Setup

1. Under **Settings > Devices & services > Helpers**, create a **Number** helper. Set a range that contains the source's expected values and a step small enough for the precision you want to retain.
2. Set the helper to the desired starting average. To avoid a startup ramp from another value, use the source's current measurement.
3. Under **Settings > Automations & scenes**, create an automation from **Hippo's Time-Based Exponential Moving Average (EMA)**.
4. Select the input sensor and average helper.
5. Choose the period length and precision, then save and leave the automation enabled. The defaults are **4 samples** and **1 decimal place**.
6. Watch the Number helper over the next few minute boundaries. It should move toward a different source value even if the source itself stays unchanged.

The blueprint does not create or initialize the Number helper. Each automation samples at the start of each minute, rather than on every source update.

## Choose the response speed

A larger period length produces a smoother average that reacts more slowly. The smoothing factor and update are:

```text
alpha = 2 / (period length + 1)
next average = alpha × current measurement + (1 - alpha) × previous average
```

At the default period length of 4, `alpha` is 0.4. Each sample therefore gives 40% weight to the current measurement and 60% to the previous average before rounding.

## Precision and missing values

Precision controls the number of decimal places stored. Rising results round upward and falling results round downward so small updates can still advance the stored value. If the source and average already match at the configured precision, the helper is not written again.

Both the source and helper must have numeric states. An invalid, unknown, or unavailable value skips that sample and leaves the stored average unchanged.
