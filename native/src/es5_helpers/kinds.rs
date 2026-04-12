#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(super) enum SharedEs5HelperKind {
    ClassPrivateFieldSet,
    ClassPrivateFieldGet,
    SetFunctionName,
    RunInitializers,
    EsDecorate,
    ClosureTemplateObject,
    ClosureInherits,
}

impl SharedEs5HelperKind {
    pub(super) fn key(self) -> &'static str {
        match self {
            Self::ClassPrivateFieldSet => "class-private-field-set",
            Self::ClassPrivateFieldGet => "class-private-field-get",
            Self::SetFunctionName => "set-function-name",
            Self::RunInitializers => "run-initializers",
            Self::EsDecorate => "es-decorate",
            Self::ClosureTemplateObject => "closure-template-object",
            Self::ClosureInherits => "closure-inherits",
        }
    }

    pub(super) fn slot(self) -> usize {
        match self {
            Self::ClassPrivateFieldSet => 0,
            Self::ClassPrivateFieldGet => 1,
            Self::SetFunctionName => 2,
            Self::RunInitializers => 3,
            Self::EsDecorate => 4,
            Self::ClosureTemplateObject => 5,
            Self::ClosureInherits => 6,
        }
    }
}
