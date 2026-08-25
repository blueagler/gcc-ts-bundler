//! Types for Oxc dynamic-import wrapper-flow analysis.

use std::collections::{BTreeMap, BTreeSet};

use crate::transpile::identity::BindingKeyMap;

#[derive(Clone, Debug, Default)]
pub(crate) struct DynamicImportWrappers {
    pub(crate) function_wrappers: BindingKeyMap<BTreeSet<String>>,
    pub(crate) object_wrappers: BindingKeyMap<DynamicImportObjectWrapper>,
    pub(crate) object_function_wrappers: BindingKeyMap<DynamicImportObjectWrapper>,
}

pub(crate) type DynamicImportObjectWrapper = BTreeMap<String, BTreeSet<String>>;
