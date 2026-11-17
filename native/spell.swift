// Espaces — le correcteur d'orthographe du système (Mac, iPad, iPhone), en français et hors ligne : aucun texte ne quitte l'appareil.
// Sur Mac, le système relève aussi des fautes de grammaire. Sur iOS, seule l'orthographe existe : les règles d'accord sont dans la page.

import Foundation
#if os(iOS)
import UIKit
#else
import AppKit
#endif

enum Spell {
    private static func issue(_ s: Int, _ l: Int, _ k: String, _ g: [String], _ m: String = "") -> [String: Any] {
        ["s": s, "l": l, "k": k, "g": Array(g.prefix(4)), "m": m]
    }

    #if os(iOS)
    private static let checker = UITextChecker()
    private static let lang: String = UITextChecker.availableLanguages.first { $0.hasPrefix("fr") } ?? "fr_FR"

    static func check(_ text: String) -> [[String: Any]] {
        var out: [[String: Any]] = []
        let n = (text as NSString).length
        var at = 0
        while at < n {
            let r = checker.rangeOfMisspelledWord(in: text, range: NSRange(location: 0, length: n), startingAt: at, wrap: false, language: lang)
            if r.location == NSNotFound { break }
            out.append(issue(r.location, r.length, "s", checker.guesses(forWordRange: r, in: text, language: lang) ?? []))
            at = r.location + max(1, r.length)
        }
        return out
    }
    static func learn(_ word: String) { UITextChecker.learnWord(word) }
    #else
    static func check(_ text: String) -> [[String: Any]] {
        let c = NSSpellChecker.shared
        c.automaticallyIdentifiesLanguages = false
        c.setLanguage("fr")
        let whole = NSRange(location: 0, length: (text as NSString).length)
        var out: [[String: Any]] = []
        let found = c.check(text, range: whole, types: NSTextCheckingResult.CheckingType.spelling.rawValue | NSTextCheckingResult.CheckingType.grammar.rawValue, options: [:], inSpellDocumentWithTag: 0, orthography: nil, wordCount: nil)
        for r in found {
            if r.resultType == .spelling {
                out.append(issue(r.range.location, r.range.length, "s", c.guesses(forWordRange: r.range, in: text, language: "fr", inSpellDocumentWithTag: 0) ?? []))
            } else if r.resultType == .grammar {
                for d in r.grammarDetails ?? [] {
                    guard let v = d[NSGrammarRange] as? NSValue else { continue }
                    let g = v.rangeValue
                    out.append(issue(r.range.location + g.location, g.length, "g", d[NSGrammarCorrections] as? [String] ?? [], d[NSGrammarUserDescription] as? String ?? ""))
                }
            }
        }
        return out
    }
    static func learn(_ word: String) { NSSpellChecker.shared.learnWord(word) }
    #endif
}
