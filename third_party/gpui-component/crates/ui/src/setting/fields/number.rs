use std::rc::Rc;

use gpui::{
    AnyElement, App, AppContext as _, Entity, IntoElement, SharedString, StyleRefinement, Styled,
    Subscription, Window, prelude::FluentBuilder as _,
};

use crate::{
    AxisExt, Disableable, Sizable, StyledExt,
    input::{InputEvent, InputState, NumberInput},
    setting::{
        AnySettingField, RenderOptions,
        fields::{SettingFieldRender, get_value, set_value},
    },
};

#[derive(Clone, Debug)]
pub struct NumberFieldOptions {
    /// The minimum value for the number input, default is `f64::MIN`.
    pub min: f64,
    /// The maximum value for the number input, default is `f64::MAX`.
    pub max: f64,
    /// The step value for the number input, default is `1.0`.
    pub step: f64,
}

impl Default for NumberFieldOptions {
    fn default() -> Self {
        Self {
            min: f64::MIN,
            max: f64::MAX,
            step: 1.0,
        }
    }
}

pub(crate) struct NumberField {
    options: NumberFieldOptions,
}

impl NumberField {
    pub(crate) fn new(options: Option<&NumberFieldOptions>) -> Self {
        Self {
            options: options.cloned().unwrap_or_default(),
        }
    }
}

struct State {
    input: Entity<InputState>,
    initial_value: f64,
    _subscriptions: Vec<Subscription>,
}

impl SettingFieldRender for NumberField {
    fn render(
        &self,
        field: Rc<dyn AnySettingField>,
        options: &RenderOptions,
        style: &StyleRefinement,
        window: &mut Window,
        cx: &mut App,
    ) -> AnyElement {
        let value = get_value::<f64>(&field, cx);
        let set_value = set_value::<f64>(&field, cx);
        let num_options = self.options.clone();

        let state_entity = window.use_keyed_state(
            SharedString::from(format!(
                "number-state-{}-{}-{}",
                options.page_ix(),
                options.group_ix(),
                options.item_ix()
            )),
            cx,
            |window, cx| {
                let input = cx.new(|cx| {
                    InputState::new(window, cx)
                        .default_value(value.to_string())
                        .min(num_options.min)
                        .max(num_options.max)
                        .step(num_options.step)
                });
                let _subscriptions = vec![cx.subscribe_in(&input, window, {
                    move |state: &mut State, input, event: &InputEvent, window, cx| {
                        let commit =
                            matches!(event, InputEvent::Blur | InputEvent::PressEnter { .. });
                        if !commit && !matches!(event, InputEvent::Change) {
                            return;
                        }
                        let text = input.read(cx).value();
                        let parsed = text.parse::<f64>().ok().filter(|value| value.is_finite());
                        let next = if commit {
                            // Empty/unfinished edits restore the last accepted value.
                            parsed
                                .unwrap_or(state.initial_value)
                                .clamp(num_options.min, num_options.max)
                        } else {
                            // Keep partial numbers ("", "6", "-") editable. Only a
                            // complete in-range value updates the live setting.
                            let Some(value) = parsed.filter(|value| {
                                *value >= num_options.min && *value <= num_options.max
                            }) else {
                                return;
                            };
                            value
                        };
                        if next != state.initial_value {
                            set_value(next, cx);
                            state.initial_value = next;
                        }
                        if commit && text != next.to_string() {
                            input.update(cx, |input, cx| {
                                input.set_value(next.to_string(), window, cx);
                            });
                        }
                    }
                })];

                State {
                    input,
                    initial_value: value,
                    _subscriptions,
                }
            },
        );

        // Sync the displayed value when the underlying setting changed externally
        state_entity.update(cx, |state, cx| {
            if state.initial_value != value {
                state.initial_value = value;
                state.input.update(cx, |input, cx| {
                    input.set_value(SharedString::from(value.to_string()), window, cx);
                });
            }
        });

        let state = state_entity.read(cx);

        NumberInput::new(&state.input)
            .disabled(options.is_disabled())
            .with_size(options.size())
            .map(|this| {
                if options.layout().is_horizontal() {
                    this.w_32()
                } else {
                    this.w_full()
                }
            })
            .refine_style(style)
            .into_any_element()
    }
}
