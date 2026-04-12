mod report;
mod rewrite;
mod utils;

use std::path::PathBuf;

use swc_core::ecma::visit::VisitMutWith;

use crate::module_cache::parse_module;

use self::report::parse_property_renaming_report;
use self::rewrite::PropertyProtocolRewriter;
use self::utils::print_module_minified;

pub fn rewrite_decorator_metadata(
    code: String,
    property_renaming_report: String,
) -> std::result::Result<String, String> {
    if property_renaming_report.trim().is_empty() {
        return Ok(code);
    }

    let renames = parse_property_renaming_report(&property_renaming_report);
    if renames.is_empty() {
        return Ok(code);
    }

    let mut module = parse_module(&PathBuf::from("property-protocol-bundle.js"), &code)?;
    let mut rewriter = PropertyProtocolRewriter::new(&renames);
    module.visit_mut_with(&mut rewriter);
    if !rewriter.changed {
        return Ok(code);
    }

    print_module_minified(&module)
}

#[cfg(test)]
mod tests {
    use super::rewrite_decorator_metadata;

    #[test]
    fn rewrites_decorator_metadata_names_and_access_has_checks() {
        let output = rewrite_decorator_metadata(
            "function g(A,y,d,b,e,n){return b}g(b,null,e,{kind:\"accessor\",name:\"letters\",static:!1,private:!1,access:{has:H=>\"letters\"in H,get:H=>H.J,set:(H,J)=>{H.J=J}},metadata:D},n,z);".to_string(),
            "letters:J\n".to_string(),
        )
        .expect("rewrite");

        assert!(output.contains("name:\"J\""), "{output}");
        assert!(output.contains("\"J\"in H"), "{output}");
    }

    #[test]
    fn leaves_unrelated_string_literals_untouched() {
        let output = rewrite_decorator_metadata(
            "console.log(\"letters\");g(b,null,e,{kind:\"accessor\",name:\"letters\",static:!1,private:!1,access:{has:H=>\"letters\"in H,get:H=>H.J,set:(H,J)=>{H.J=J}},metadata:D},n,z);".to_string(),
            "letters:J\n".to_string(),
        )
        .expect("rewrite");

        assert!(output.contains("console.log(\"letters\")"), "{output}");
        assert!(output.contains("name:\"J\""), "{output}");
    }

    #[test]
    fn skips_metadata_without_string_literal_names() {
        let input =
            "g(null,y={value:b},A,{kind:\"class\",name:b.name,metadata:D},null,d);".to_string();
        let output =
            rewrite_decorator_metadata(input.clone(), "letters:J\n".to_string()).expect("rewrite");

        assert_eq!(output, input);
    }

    #[test]
    fn rewrites_property_key_comparisons_for_for_in_variables() {
        let output = rewrite_decorator_metadata(
            "for(const key in attrs){if(key===\"class\"){apply(attrs[key])}else if(key!==\"style\"){sync(key)}}".to_string(),
            "class:o\nstyle:i\n".to_string(),
        )
        .expect("rewrite");

        assert!(output.contains("key===\"o\""), "{output}");
        assert!(output.contains("key!==\"i\""), "{output}");
    }

    #[test]
    fn rewrites_space_separated_property_lists() {
        let output = rewrite_decorator_metadata(
            "const keys=\"$$slots $$events $$legacy variant children\".split(\" \");".to_string(),
            "$$slots:i\n$$events:j\n$$legacy:k\nvariant:l\n".to_string(),
        )
        .expect("rewrite");

        assert!(
            output.contains("\"i j k l children\".split(\" \")"),
            "{output}"
        );
    }

    #[test]
    fn rewrites_array_literal_key_lists_passed_to_key_filter_functions() {
        let output = rewrite_decorator_metadata(
            "(function(props,exclude){for(const key in props){if(exclude.includes(key))continue;use(key)}})(attrs,[\"$$slots\",\"$$events\",\"$$legacy\",\"variant\"]);".to_string(),
            "$$slots:i\n$$events:j\n$$legacy:k\nvariant:l\n".to_string(),
        )
        .expect("rewrite");

        assert!(output.contains("[\"i\",\"j\",\"k\",\"l\"]"), "{output}");
    }

    #[test]
    fn leaves_plain_string_arrays_untouched() {
        let input = "const letters=[\"L\",\"I\",\"T\"];".to_string();
        let output =
            rewrite_decorator_metadata(input.clone(), "L:fc\nI:qb\nT:Pa\n".to_string())
                .expect("rewrite");

        assert_eq!(output, input);
    }

    #[test]
    fn leaves_plain_css_property_arrays_untouched() {
        let input =
            "const props=[\"left\",\"top\",\"width\",\"height\",\"opacity\",\"color\",\"background\"];"
                .to_string();
        let output = rewrite_decorator_metadata(
            input.clone(),
            "left:a\ntop:b\nwidth:c\nheight:d\nopacity:e\ncolor:0\nbackground:g\n".to_string(),
        )
        .expect("rewrite");

        assert_eq!(output, input);
    }

    #[test]
    fn rewrites_switch_cases_for_property_key_variables() {
        let output = rewrite_decorator_metadata(
            "for(const key in attrs){switch(key){case\"class\":a();break;case\"role\":b();break;}}".to_string(),
            "class:o\nrole:r\n".to_string(),
        )
        .expect("rewrite");

        assert!(output.contains("case\"o\""), "{output}");
        assert!(output.contains("case\"r\""), "{output}");
    }

    #[test]
    fn rewrites_string_in_checks_outside_decorator_metadata() {
        let output = rewrite_decorator_metadata(
            "if(\"label\" in props){use(props)}".to_string(),
            "label:sa\n".to_string(),
        )
        .expect("rewrite");

        assert!(output.contains("\"sa\"in props"), "{output}");
    }

    #[test]
    fn rewrites_member_carrier_comparisons_for_property_keys() {
        let output = rewrite_decorator_metadata(
            "for(var key in attrs){state.current=key;if(state.current===\"class\"){apply(attrs[key])}}"
                .to_string(),
            "class:o\n".to_string(),
        )
        .expect("rewrite");

        assert!(output.contains("state.current===\"o\""), "{output}");
    }
}
