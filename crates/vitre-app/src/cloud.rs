//! Cloud service operations and presentation shared by conversations and settings.
pub(crate) mod diff;
mod forms;
mod presentation;
pub(crate) mod store;
use gpui::{
    AnyElement, App, Hsla, InteractiveElement as _, IntoElement, ParentElement as _, SharedString,
    Styled as _, actions, div, prelude::FluentBuilder as _, px,
};
use gpui_component::{
    ActiveTheme as _, Icon, IconName, Sizable as _, StyledExt as _,
    button::{Button, ButtonVariants as _},
    h_flex,
    tag::Tag,
    v_flex,
};
use vitre_contracts::{CloudProvider, CloudTask, CloudTaskKind, CloudTaskState};

pub(crate) use forms::{Sheet, render_sheet as render_sheet_card};
pub(crate) use presentation::*;
pub(crate) use store::{CloudStore, Op, SessionState};
actions!(vitre, [NewCloudThread]);
#[cfg(any(test, debug_assertions))]
pub(crate) mod tests;
