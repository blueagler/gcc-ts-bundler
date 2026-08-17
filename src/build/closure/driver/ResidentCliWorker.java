import com.google.common.base.Function;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.javascript.jscomp.AbstractCommandLineRunner;
import com.google.javascript.jscomp.CommandLineRunner;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.PrintStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;

/**
 * Sequential Closure CLI jobs in one JVM. Each stdin frame is a NUL-terminated
 * JSON object {@code {"args":["--flag=value",...]}}. Replies are {@code
 * {"exitCode":N,"stdout":"...","stderr":"..."}} plus NUL.
 *
 * <p>Uses the public {@code setExitCodeReceiver} hook so {@code run()} does not
 * {@code System.exit}. Construction goes through the protected four-argument
 * {@code CommandLineRunner} constructor so the compiler never reads protocol
 * stdin. If either hook disappears, the Node probe fails and the caller falls
 * back to per-job spawn.
 */
public final class ResidentCliWorker {
  private ResidentCliWorker() {}

  public static void main(String[] args) throws Exception {
    PrintStream protocol = System.out;
    System.setOut(new PrintStream(OutputStream.nullOutputStream(), true, StandardCharsets.UTF_8));
    writeReady(protocol);
    ByteArrayOutputStream frame = new ByteArrayOutputStream();
    int next;
    while ((next = System.in.read()) != -1) {
      if (next == 0) {
        writeReply(protocol, runJob(frame.toByteArray()));
        frame.reset();
      } else {
        frame.write(next);
      }
    }
  }

  private static void writeReady(PrintStream protocol) throws Exception {
    JsonObject ready = new JsonObject();
    ready.addProperty("ready", true);
    ready.addProperty("pid", ProcessHandle.current().pid());
    writeReply(protocol, ready);
  }

  private static JsonObject runJob(byte[] raw) {
    JsonObject reply = new JsonObject();
    try {
      JsonObject request =
          JsonParser.parseString(new String(raw, StandardCharsets.UTF_8)).getAsJsonObject();
      JsonArray argList = request.getAsJsonArray("args");
      String[] cliArgs = new String[argList.size()];
      for (int i = 0; i < argList.size(); i++) {
        cliArgs[i] = argList.get(i).getAsString();
      }

      ByteArrayOutputStream stdout = new ByteArrayOutputStream();
      ByteArrayOutputStream stderr = new ByteArrayOutputStream();
      PrintStream out = new PrintStream(stdout, true, StandardCharsets.UTF_8);
      PrintStream err = new PrintStream(stderr, true, StandardCharsets.UTF_8);
      int[] exitCode = {0};

      Constructor<?> constructor =
          CommandLineRunner.class.getDeclaredConstructor(
              String[].class, InputStream.class, PrintStream.class, PrintStream.class);
      constructor.setAccessible(true);
      Object runner =
          constructor.newInstance(cliArgs, InputStream.nullInputStream(), out, err);

      Method setExitCodeReceiver =
          AbstractCommandLineRunner.class.getMethod("setExitCodeReceiver", Function.class);
      setExitCodeReceiver.invoke(
          runner,
          new Function<Integer, Void>() {
            @Override
            public Void apply(Integer code) {
              exitCode[0] = code.intValue();
              return null;
            }
          });

      Method shouldRunCompiler = CommandLineRunner.class.getMethod("shouldRunCompiler");
      if (Boolean.TRUE.equals(shouldRunCompiler.invoke(runner))) {
        AbstractCommandLineRunner.class.getMethod("run").invoke(runner);
      } else {
        Method hasErrors = CommandLineRunner.class.getMethod("hasErrors");
        if (Boolean.TRUE.equals(hasErrors.invoke(runner))) {
          exitCode[0] = -1;
        }
      }

      out.flush();
      err.flush();
      reply.addProperty("exitCode", exitCode[0]);
      reply.addProperty("stdout", stdout.toString(StandardCharsets.UTF_8));
      reply.addProperty("stderr", stderr.toString(StandardCharsets.UTF_8));
    } catch (Throwable error) {
      reply.addProperty("exitCode", -2);
      reply.addProperty("stdout", "");
      reply.addProperty(
          "stderr", error.getClass().getName() + ": " + String.valueOf(error.getMessage()));
    }
    return reply;
  }

  private static void writeReply(PrintStream protocol, JsonObject payload) throws Exception {
    protocol.write(payload.toString().getBytes(StandardCharsets.UTF_8));
    protocol.write(0);
    protocol.flush();
  }
}
