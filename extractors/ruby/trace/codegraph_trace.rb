# frozen_string_literal: true

# codegraph-trace — what a running Ruby program knows that its source does not
# write, for `codegraph-ruby --trace` (PLAN.md §19.5).
#
# Require it FIRST, in a program that loads the code to be read, and it writes
# `codegraph-trace.jsonl` when the program exits:
#
#   ruby -r/path/to/codegraph_trace -e 'require "./config/environment"; Rails.application.eager_load!'
#   CODEGRAPH_TRACE_CALLS=1 RUBYOPT=-r/path/to/codegraph_trace bundle exec rake test
#
# It runs YOUR code, which the extractor never does: that is why it is a
# separate step, yours to take, in a project that still boots. One file, no
# dependency beyond `json`, nothing patched: it reads the VM when the program
# is done and, when asked, listens to the calls it makes.
#
#   CODEGRAPH_TRACE_ROOT   the directory given to `--src` (default: the working directory)
#   CODEGRAPH_TRACE_OUT    the file to write (default: codegraph-trace.jsonl)
#   CODEGRAPH_TRACE_CALLS  1 to record calls too — every call is slowed, so run the tests, not production
#
# The trace names things as Ruby does — a constant path, a file and a line —
# and carries no key: the extractor finds its own entities from them.
require "json"

module CodegraphTrace
  VERSION = "0.1.0"
  ROOT = "#{File.expand_path(ENV['CODEGRAPH_TRACE_ROOT'] || Dir.pwd)}/"
  OUT = File.expand_path(ENV["CODEGRAPH_TRACE_OUT"] || "codegraph-trace.jsonl")

  # A class may redefine `name` or `ancestors`: ask the VM, not the class.
  NAME = Module.instance_method(:name)
  ANCESTORS = Module.instance_method(:ancestors)
  INSTANCE_METHODS = Module.instance_method(:instance_methods)
  PRIVATE_INSTANCE_METHODS = Module.instance_method(:private_instance_methods)
  INSTANCE_METHOD = Module.instance_method(:instance_method)
  SINGLETON_CLASS = Kernel.instance_method(:singleton_class)

  @calls = {}

  class << self
    def name_of(mod)
      NAME.bind(mod).call
    end

    def ancestors_of(mod)
      ANCESTORS.bind(mod).call
    end

    # A path below the root, as the extractor writes it; nil for anything else
    # — a library's file, or the VM's own (`<internal:kernel>`).
    def relative(path)
      return nil if path.nil? || path.start_with?("<")

      path = File.expand_path(path)
      path[ROOT.length..-1] if path.start_with?(ROOT)
    end

    # Whether the program's own code has a hand in `type`: a method of it
    # written below the root, or the constant itself defined there.
    def ours?(type, methods)
      return true unless methods.empty?
      return true unless Object.respond_to?(:const_source_location)

      file, = Object.const_source_location(type)
      !relative(file).nil?
    rescue NameError
      false
    end

    # Those no other one of them already brings along.
    def direct(mixed)
      mixed.reject do |mod|
        mixed.any? { |other| !other.equal?(mod) && ancestors_of(other).include?(mod) }
      end
    end

    def named(mods)
      mods.map { |mod| name_of(mod) }.compact
    end

    # What `mod` itself mixes in, by how: not what its superclass did, nor
    # what a module it includes brought.
    def mixins_of(mod)
      ancestors = ancestors_of(mod)
      own = ancestors.index(mod) || 0
      superclass = mod.is_a?(Class) ? mod.superclass : nil
      inherited = superclass ? ancestors_of(superclass) : []
      included = ancestors[(own + 1)..-1].reject { |ancestor| ancestor.is_a?(Class) } - inherited
      prepended = ancestors[0...own]
      meta = SINGLETON_CLASS.bind(mod).call
      # What every class or module answers, and what the superclass was extended with.
      base = superclass ? SINGLETON_CLASS.bind(superclass).call : (mod.is_a?(Class) ? Class : Module)
      extended = meta.included_modules - base.included_modules
      {
        "include" => named(direct(included)),
        "prepend" => named(direct(prepended)),
        "extend" => named(direct(extended)),
      }
    end

    # Every method the VM holds for `mod` that is defined in a file below the root.
    def methods_of(mod, singleton)
      holder = singleton ? SINGLETON_CLASS.bind(mod).call : mod
      names = INSTANCE_METHODS.bind(holder).call(false) + PRIVATE_INSTANCE_METHODS.bind(holder).call(false)
      names.uniq.map do |name|
        file, line = INSTANCE_METHOD.bind(holder).call(name).source_location
        file = relative(file)
        [name.to_s, file, line] if file
      end.compact
    end

    def listen
      @trace = TracePoint.new(:call) do |tp|
        at = relative(tp.path)
        next unless at

        # Frame 1 is the method just entered; frame 2 is whoever called it.
        site = caller_locations(2, 1).first
        file = site && relative(site.absolute_path || site.path)
        next unless file

        @calls[[file, site.lineno, tp.method_id.to_s, at, tp.lineno]] = true
      end
      @trace.enable
    end

    def records
      mixins = []
      methods = []
      ObjectSpace.each_object(Module) do |mod|
        next if mod.singleton_class?

        type = name_of(mod)
        next unless type

        own = [false, true].flat_map do |singleton|
          methods_of(mod, singleton).map do |name, file, line|
            { "t" => "method", "type" => type, "name" => name, "singleton" => singleton,
              "file" => file, "line" => line }
          end
        end
        # A library's class the program never touches says nothing about the program.
        next unless ours?(type, own)

        methods.concat(own)
        mixins_of(mod).each do |how, names|
          names.each { |name| mixins << { "t" => "mixin", "type" => type, "how" => how, "module" => name } }
        end
      end
      calls = @calls.keys.map do |file, line, name, at, defined|
        { "t" => "call", "file" => file, "line" => line, "name" => name, "at" => at, "def" => defined }
      end
      [mixins, methods, calls].map { |list| list.map { |record| JSON.generate(record) }.uniq.sort }
    end

    def write
      @trace&.disable
      mixins, methods, calls = records
      header = { "t" => "header", "tool" => "codegraph-trace", "version" => VERSION,
                 "ruby" => RUBY_VERSION, "root" => ROOT.chomp("/") }
      eof = { "t" => "eof", "mixins" => mixins.size, "methods" => methods.size, "calls" => calls.size }
      File.write(OUT, ([JSON.generate(header)] + mixins + methods + calls + [JSON.generate(eof)]).join("\n") + "\n")
      warn "codegraph-trace: #{mixins.size} mixins, #{methods.size} methods, #{calls.size} calls -> #{OUT}"
    end
  end

  listen if ENV["CODEGRAPH_TRACE_CALLS"] == "1"
  at_exit { write }
end
